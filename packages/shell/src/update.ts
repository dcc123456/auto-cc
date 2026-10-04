import { Service, type Context } from '@auto-cc/core';
import type { UpdateState, UpdateView } from '@auto-cc/shared';
import { z } from 'zod';

/**
 * 更新通道的配置（`cordis.yml` 里 `update` 那一条）。
 *
 * `feedUrl` 刻意**没有默认值**：判据要求"默认不指向 GitHub 直连"（plan §7.7.2.1 第 3 条 + §9 的网络事实），
 * 所以没有配置就没有更新源，服务在这种情况下连更新器单例都不取，一条请求都不发。
 */
export const updateSchema = z.strictObject({
  /** 自建静态目录（generic provider）的根地址，指向放 `latest.yml` 与安装包的那一层 */
  feedUrl: z.string().url().optional(),
  /** dev 下强制读 `dev-app-update.yml`；只为取验收证据而开，默认关（plan §7.7.2.1 第 2 条） */
  forceDevUpdateConfig: z.boolean().default(false),
});

/** 构造器第二个实参的类型，取 schema 的**输出**（§9 的 1.3 实测：带 `.default()` 的键在直接调用点必须给出）。 */
export type UpdateConfig = z.output<typeof updateSchema>;

/** 三条"自动开飞"开关——electron-updater 构造函数的默认值全是 true（实测：`out/AppUpdater.js:109/114/119`）。 */
export interface AutopilotSwitches {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  autoRunAppAfterInstall: boolean;
}

/** `checkForUpdates()` 的返回形状（实测 `out/types.d.ts:26-33`），只取本服务用到的两位。 */
export interface UpdateCheckResultLike {
  isUpdateAvailable?: boolean;
  updateInfo?: { version?: string };
}

/**
 * 本通道用到的更新器单例投影。
 *
 * 只声明接口、不 `new NsisUpdater()`：`electron-updater` 导出的是模块级单例（实测 `out/main.d.ts:13`），
 * 主干部第二份就等于有两条互不知情的更新状态机（§2.7 禁止第二套同类基础设施）。
 */
export interface UpdaterLike extends AutopilotSwitches {
  forceDevUpdateConfig: boolean;
  setFeedURL(options: { provider: 'generic'; url: string }): void;
  checkForUpdates(): Promise<UpdateCheckResultLike | null>;
  downloadUpdate(): Promise<string[]>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

/** 运行期才需要的两个外部事实：更新器单例与当前版本号。延迟取，模块导入期不碰 electron。 */
export interface UpdateRuntime {
  updater: UpdaterLike;
  version: string;
}

/**
 * 真实运行期依赖：`electron-updater` 的单例 + Electron 自己的版本号。
 * @returns 更新器与当前版本
 */
async function realRuntime(): Promise<UpdateRuntime> {
  const [{ autoUpdater }, { app }] = await Promise.all([import('electron-updater'), import('electron')]);
  return { updater: autoUpdater as unknown as UpdaterLike, version: app.getVersion() };
}

/**
 * 把三条自动开飞开关关死——接这个库的**前置硬条件**，不是可选打磨。
 * @param updater 待设置的更新器（真实单例或测试替身）
 */
export function armManualOnly(updater: AutopilotSwitches): void {
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.autoRunAppAfterInstall = false;
}

/**
 * 复核三条开关确实关着；只要有一条还是 true 就抛，调用方因此拿不到任何网络或安装动作。
 *
 * 存在的意义是防"以后有人把 `armManualOnly` 那行删了/挪了"：默认值就是全自动，
 * 删掉一行会让 app 在首启动后台下载并静默安装重启，而 spec 5.9-03 判的正是这一条。
 * @param updater 待复核的更新器
 * @throws Error 以 `UPDATE_AUTOPILOT_ENABLED:` 开头，后接还没关掉的开关名
 */
export function assertManualOnly(updater: AutopilotSwitches): void {
  const stillEnabled = (['autoDownload', 'autoInstallOnAppQuit', 'autoRunAppAfterInstall'] as const).filter(
    (key) => updater[key] !== false,
  );
  if (stillEnabled.length > 0) throw new Error(`UPDATE_AUTOPILOT_ENABLED: ${stillEnabled.join(', ')}`);
}

/** 三条口的动作名，决定状态机往哪走。 */
export type UpdateActionName = 'check' | 'download' | 'install';

/**
 * 更新通道的状态机（spec 5.9-03）：**提示 + 用户主动触发**，失败不阻塞使用。
 *
 * idle / no-feed / unavailable-in-dev / up-to-date →（人点）available →（人点）downloading →
 * downloaded →（人点）安装重启。每一跳都要一次点击，没有一跳由定时器或事件自己走。
 * 单独成类（不写在 Service 里）是为了让这条状态机能在无 cordis 上下文的情况下被逐条测到。
 */
export class UpdateChannel {
  private view: UpdateView;

  /**
   * @param options 已按 schema 校验过的配置（`feedUrl` 缺省即"没有更新源"）
   * @param resolveRuntime 运行期依赖的取法，测试注入替身；缺省取真实的更新器单例
   */
  constructor(
    private readonly options: UpdateConfig,
    private readonly resolveRuntime: () => Promise<UpdateRuntime> = realRuntime,
  ) {
    this.view = { state: 'idle', currentVersion: '', latestVersion: null, detail: null };
  }

  /**
   * 上一次的读数，不产生任何网络请求。
   * @returns 状态读数；从未点过时是 `idle` 且 `currentVersion` 为空串
   */
  status(): UpdateView {
    return this.view;
  }

  /**
   * 向配置里的更新源问一次版本号（唯一会发元数据请求的口）。
   * @returns 本次读数；无更新源 → `no-feed`，dev 未强制 → `unavailable-in-dev`，出错 → `failed`
   */
  check(): Promise<UpdateView> {
    return this.run('check');
  }

  /**
   * 下载安装包，只在上一态是 `available` 时被允许。
   * @returns 本次读数；上一态不符时原态返回并带一句拒因
   */
  download(): Promise<UpdateView> {
    return this.run('download');
  }

  /**
   * 重启并安装，只在上一态是 `downloaded` 时被允许。
   * @returns 本次读数；上一态不符时原态返回并带一句拒因
   */
  install(): Promise<UpdateView> {
    return this.run('install');
  }

  /**
   * 三条口的共同执行体：先关死自动开飞，再按状态机走一跳，任何异常只落一句原话。
   * @param action 本次动作
   * @returns 动作后的读数（失败也返回，不抛给渲染层）
   */
  private async run(action: UpdateActionName): Promise<UpdateView> {
    if (!this.options.feedUrl) {
      this.view = { ...this.view, state: 'no-feed', detail: null };
      return this.view;
    }
    let resolvedVersion: string | undefined;
    try {
      const { updater, version } = await this.resolveRuntime();
      resolvedVersion = version;
      armManualOnly(updater);
      assertManualOnly(updater);
      updater.forceDevUpdateConfig = this.options.forceDevUpdateConfig;
      updater.setFeedURL({ provider: 'generic', url: this.options.feedUrl });
      this.view = await this.advance(action, updater, version);
    } catch (error) {
      // 失败只落一句原话：更新通道坏了不能把 app 一起带走（spec 5.9-03 的"不阻塞使用"）。
      // 版本号在失败时也要留住——它是"我现在跑的是哪一版"这条读数，与检查成败无关。
      this.view = {
        ...this.view,
        currentVersion: resolvedVersion ?? this.view.currentVersion,
        state: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    return this.view;
  }

  /**
   * 按动作推进一格状态机。
   * @param updater 已复核过三条开关的更新器
   * @param version 当前运行版本（`app.getVersion()`）
   * @returns 推进后的读数
   */
  private async advance(action: UpdateActionName, updater: UpdaterLike, version: string): Promise<UpdateView> {
    if (action === 'check') {
      const result = await updater.checkForUpdates();
      // dev 且未 forceDevUpdateConfig 时库自己返回 null（实测 `out/AppUpdater.js:278-280`），
      // 这一态明确写出来，是为了不让"dev 里点了没反应"被误读成"已经检查过、没有新版"。
      if (result === null) {
        return { state: 'unavailable-in-dev', currentVersion: version, latestVersion: null, detail: null };
      }
      const latest = result.updateInfo?.version ?? null;
      const state: UpdateState = result.isUpdateAvailable ? 'available' : 'up-to-date';
      return { state, currentVersion: version, latestVersion: state === 'available' ? latest : null, detail: null };
    }
    if (action === 'download') {
      if (this.view.state !== 'available') {
        return { ...this.view, detail: 'UPDATE_NOT_AVAILABLE: download requires state=available' };
      }
      this.view = { ...this.view, state: 'downloading', detail: null };
      await updater.downloadUpdate();
      return { ...this.view, state: 'downloaded', detail: null };
    }
    if (this.view.state !== 'downloaded') {
      return { ...this.view, detail: 'UPDATE_NOT_DOWNLOADED: install requires state=downloaded' };
    }
    // 静默安装 + 装完立刻重启：走到这里已经是用户第二次表态（第一次是点"下载"）。
    updater.quitAndInstall(true, true);
    return this.view;
  }
}

/**
 * 更新通道的服务外壳：把 `UpdateChannel` 挂到 cordis 上并暴露成四条白名单口。
 *
 * 没有 `inject`，也不在挂载期碰更新器单例——取单例、关三条开关、发请求都发生在被调用的那一刻，
 * 所以"注掉 `cordis.yml` 里那一行"的效果是界面四条口得到「服务未挂载」，而 app 照常启动。
 */
export class UpdateService extends Service {
  static provide = 'update';
  static Config = updateSchema;

  private readonly channel: UpdateChannel;

  constructor(ctx: Context, options: UpdateConfig) {
    super(ctx, 'update');
    this.channel = new UpdateChannel(options);
  }

  /** @returns 上一次读数，不发请求 */
  status(): UpdateView {
    return this.channel.status();
  }

  /** @returns 检查之后的读数 */
  check(): Promise<UpdateView> {
    return this.channel.check();
  }

  /** @returns 下载之后的读数 */
  download(): Promise<UpdateView> {
    return this.channel.download();
  }

  /** @returns 安装（重启）之前的读数 */
  install(): Promise<UpdateView> {
    return this.channel.install();
  }
}
