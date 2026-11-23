import path from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  Notification,
  shell as electronShell,
  Tray,
  WebContentsView,
  type WebContents,
} from 'electron';
import { AppError, Service, type Context } from '@auto-cc/core';
import {
  APP_PARTITION,
  type AuthorizationPausedEvent,
  type KernelViewLoadError,
  type KernelViewRect,
  type ShellStatus,
} from '@auto-cc/shared';
import { z } from 'zod';
import { isViewLive, liveWebContentsOf } from './view-liveness.js';
import { recoveryVerdict, withRecovery } from './recovery-budget.js';
import { DEFAULT_WINDOW_SIZE, parseWindowSize } from './window-size.js';
import {
  COMPANION_EDITOR_DEFAULT_BIN,
  launchCompanion,
  planCompanionOpen,
  resolveCompanionCommand,
} from './companion-editor.js';
import { decideOpenPicker, decideSavePicker } from './file-picker.js';
import { markKernelViewUrl } from './kernel-view-url.js';
import { resolveRevealTarget } from './reveal-target.js';
import { clampSlotRect, clampZoomFactor } from './slot-bounds.js';
import { decideTakeover, topmostAlive } from './view-takeover.js';
import { armManualOnly, assertManualOnly, UpdateChannel, UpdateService, updateSchema } from './update.js';
import type {
  AutopilotSwitches,
  UpdateActionName,
  UpdateCheckResultLike,
  UpdateConfig,
  UpdateRuntime,
  UpdaterLike,
} from './update.js';

/** 仓库根目录（开发态）。 */
const repoRoot = path.resolve(__dirname, '..', '..', '..');
/**
 * 托盘与窗口图标路径；缺失时退化为空图标，不阻塞启动。
 * 打包态图标随 extraResources 落到 `process.resourcesPath/icon.png`（spec §8.2 决策 2）。
 */
const iconPath = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.png')
  : path.join(repoRoot, 'resources', 'icon.png');
/** 渲染层入口：打包态与 `main.cjs` 同在 asar 根，开发态用 vite 的构建产物目录。 */
const rendererIndexPath = app.isPackaged
  ? path.join(__dirname, 'renderer', 'index.html')
  : path.join(repoRoot, 'packages', 'renderer', 'dist', 'index.html');
/** 内核视图占位页：P1 用一行说明文字，P2 起替换为真实站点视图。 */

const kernelViewPlaceholder =
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(
    '<body style="margin:0;font:13px/1.6 system-ui;color:#64748b;background:#0f172a">' +
      '<p style="padding:12px">Embedded kernel view placeholder (WebContentsView)</p></body>',
  );

/**
 * 壳层的可选项。strict 让 `cordis.yml` 里给 shell 写错的键在挂载期就报错。
 *
 * `companionEditorBin`（spec 3.15 / plan `03-resume-pdf` §21.4）：伴生应用 Office-cc 那条命令行的名字或绝对路径。
 * 缺省 `officecc` 就够——本机装了就在 `PATH` 与常用目录里认得到；认不到时界面拿到
 * `COMPANION_EDITOR_MISSING` 那一句（说要什么），而不是"点了什么都没发生"。
 */
export const shellSchema = z.strictObject({
  companionEditorBin: z.string().default(COMPANION_EDITOR_DEFAULT_BIN),
});

/** 壳层配置的**输出**形状（带 `.default()` 的键在构造器里一定是齐的，§9 的 1.3 那条实测）。 */
export type ShellConfig = z.infer<typeof shellSchema>;

/**
 * L1 壳层服务：窗口、托盘、生命周期与内嵌内核视图。
 *
 * 这里是「薄壳」与「业务」的分界：本服务只做窗口/进程级的事，任何抓取、发送、
 * 生成类能力都不允许写进来（那属于 L2/L3 插件）。
 * 例外只有一类形状：**把一条已经存在的路径交给操作系统**——在访达里选中产物（`revealInFolder`）、
 * 请系统弹面板（`selectFile`）、把一份 PDF 交给本机另一个应用（`openInCompanionEditor`）。
 * 它们不改本 app 的状态、不产新文件、不回读结果，所以不是"业务"，是壳层替渲染层做的那次系统调用。
 *
 * 渲染层的入站校验自 1.4 起归 `ipc` 网关，shell 不再注册通道，因此声明 `inject: ['ipc']`：
 * 网关的处理器必须在主窗口创建之前就在位，否则首屏调用会撞上「No handler registered」。
 */
export class ShellService extends Service {
  static provide = 'shell';
  static Config = shellSchema;
  static inject = ['ipc'];
  /** env 覆盖名，与 `packages/store/src/index.ts` 的 `AUTOCC_STORE_DIR` 同一命名式。 */
  static envMap = { companionEditorBin: 'AUTOCC_SHELL_COMPANION_EDITOR_BIN' };

  private mainWindow: BrowserWindow | undefined;
  private kernelView: WebContentsView | undefined;
  /**
   * 被 `window.open` / target=_blank 接管进来的子视图，按创建顺序排列，**末尾叠在最上层**（spec 2.2-11）。
   * 它们与内核视图同分区、同槽位；关闭与收回必须一起清，否则 CDP 目标表里留下看不见的新标签（2.1-11）。
   */
  private takeoverViews: WebContentsView[] = [];
  private tray: Tray | undefined;
  /**
   * 内核视图当下在不在界面上。**默认 false**（裁定⑱，2026-10-06 用户表态：右侧那一条默认不展示，
   * 只有需要时才展示）；「需要」由视图里装的是不是真实站点决定，见 `createKernelView` 末尾那一句。
   */
  private kernelViewVisible = false;
  /** 内核视图当前所用的会话分区；占位页用默认会话，此处为空串。 */
  private kernelViewPartition = '';
  private kernelViewError: KernelViewLoadError | null = null;
  /**
   * 渲染层报来的容器矩形（11-03）；null = 还没报过，**不铺位**（视图保持 0×0，不造 38% 假矩形）。
   * 只存这一份而不另立"视图应在哪儿"的第二套事实：真正的布局永远在渲染层，这里只是它的一次转述。
   */
  private slotRect: KernelViewRect | null = null;
  /** 内核视图当前缩放（11-04）；默认 1 = 原生排布。 */
  private zoomFactor = 1;
  private quitting = false;
  private lastError: string | undefined;
  /** 上一次已经推给界面的内核视图地址；只用于「变了才发」，不当作读数来源（读数永远是 `getURL()`）。 */
  private pushedKernelViewUrl = '';
  /**
   * 当前内核视图「自己没了」的原因原文（2026-11-23 的 P2）。
   *
   * 与 `lastError` **分开**：`lastError` 是给人看的当前故障，而这条描述的是某一刻发生过的事；
   * 视图后来重建好了它就该消失，混进 `lastError` 会让一条早已过去的销毁一直挂在状态条上
   * （QA 复验时看到的就是这个假告警：视图健康，`lastError` 里还写着「页面被销毁」）。
   */
  private kernelViewGone: string | null = null;
  /**
   * 正在换视图（`createKernelView` 进行中）。
   *
   * 为什么需要它（2026-11-23 的间歇销毁）：换视图时我们会主动 `close()` 旧 webContents，
   * 旧视图的 `destroyed` 一定会来一发；而那一刻 `this.kernelView` 还**指在旧视图上**
   * （赋值在新视图建好之后），于是「只有当前视图被销毁才算故障」那道判据分不出
   * 「正常替换」与「真的被销毁」，还会在重建中途把记位清掉（`reapDeadKernelView`）。
   * 这个标记就是分界线：换视图期间收到 destroyed 一律当正常替换。
   */
  private remounting = false;
  /**
   * 最近若干条壳层生命周期事件（带时间戳），只为「视图没了」那一刻的现场用。
   *
   * 为什么需要（2026-11-23）：销毁栈只有两帧，看不出是谁动手；而壳层自己动视图的动作是有限的
   * （建视图 / 关旧视图 / 收回 / 收尸），留一条环形尾迹就能把「我们干的」与「外部的」分开——
   * 尾迹最后一条是「关旧视图」= 我们重建；最后一条是很久以前的事 = 外部干的。
   */
  private kernelLifecycle: string[] = [];
  /** 当前视图消失那一刻的现场（栈 + 尾迹）；视图健在时为 null。 */
  private kernelViewGoneStack: string | null = null;
  /** 站点试图关掉视图的次数（反自关注入的哨兵计数，2026-11-23）。 */
  private closeAttempts = 0;
  /** 自动恢复过的时刻（限流用，只保留窗口内的那些）。 */
  private recoveries: number[] = [];
  /** 最近一次已知的视图地址与分区：站点把页面关掉之后要按它重建（`destroyed` 时已读不到 getURL）。 */
  private lastKernelUrl = '';
  /** 最近一次已知的分区名（同上）。 */
  private lastKernelPartition = '';

  /** 启动窗口/托盘；入站通道由 `ipc` 网关注册，这里只负责界面侧。 */
  constructor(
    ctx: Context,
    private readonly config: ShellConfig,
  ) {
    super(ctx, 'shell');
    void this.launch();
  }

  /** 渲染层 `shell.getStatus` 的实现：返回当前窗口与内核视图状态。 */
  getStatus = (): ShellStatus => {
    const win = this.mainWindow;
    // 视图可能已经没了（真站上点一个下拉就能触发，2026-11-23 的 P1）：先收尸，再按「没有视图」回读数。
    // 只读口一律不许抛原生异常——上层（`sessions.status` / 地址栏 / 状态条）到处在用这两条口。
    this.reapDeadKernelView();
    const contents = liveWebContentsOf<WebContents>(this.kernelView);
    const bounds = this.kernelView?.getBounds() ?? { x: 0, y: 0, width: 0, height: 0 };
    return {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? 'unknown',
      nodeVersion: process.versions.node ?? 'unknown',
      platform: process.platform,
      windowVisible: win?.isVisible() ?? false,
      kernelViewVisible: this.kernelViewVisible,
      kernelViewBounds: bounds,
      kernelViewZoomFactor: this.zoomFactor,
      // 视图销毁后读不到 session，因此分区名取自本服务记下的那份；占位页阶段就是空串。
      // 接管子视图与父视图**共用同一个分区**（创建时传的就是这份），所以这里不需要另立读数。
      kernelViewPartition: contents === null ? '' : this.kernelViewPartition,
      kernelViewUrl: contents?.getURL() ?? '',
      // 用户实际看到的是栈顶那一个：harness 用它证明接管发生（此时 `kernelViewUrl` 仍停在被盖住的父页）。
      activeKernelViewUrl: this.activeKernelContents()?.getURL() ?? '',
      // 接管子视图的个数：与 `devtools.status().targetCount` 的增量对照，就是 2.1-11 的泄漏判据。
      kernelViewTakeoverCount: this.takeoverViews.length,
      kernelViewLoadError: this.kernelViewError,
      // 视图活着时这条恒为 null（`createKernelView` 会清）；视图没了的这一刻它才是该给人看的那句话。
      lastError: contents === null && this.kernelViewGone !== null ? this.kernelViewGone : this.lastError,
      // 销毁现场（栈 + 尾迹）随读数一起交出去：日志文件在 userData 下，读数却是随手可取的（2026-11-23）。
      kernelViewGoneStack: contents === null ? this.kernelViewGoneStack : null,
      kernelViewCloseAttempts: this.closeAttempts,
      kernelViewRecoveries: this.recoveries.length,
    };
  };

  /**
   * 让内嵌内核视图按指定会话分区加载站点（spec 1.8-02 / 1.8-08），并把那一条视图展示出来——
   * 这就是裁定⑱ 里说的"需要"：用户或 agent 要在一块真实页面上干活了。
   *
   * 分区在 `WebContentsView` 构造后不可改，所以「换平台」= 销毁旧视图 + 按新分区重建，
   * 这也是 `sessions` 只调这一个方法、不自己碰 electron 的原因（视图宿主唯一，见 §8.3 决策 1）。
   * @param partition 会话分区名（`persist:<platform>`）
   * @param url 站点起始地址
   */
  mountKernelSite = (partition: string, url: string): void => {
    this.recordLifecycle(`mountKernelSite partition=${partition} ← ${this.stackBrief(4)}`);
    this.createKernelView(partition, url);
  };

  /**
   * 收回内嵌内核视图里的站点页面，退回占位页（spec 2.1-11 的「关」），于是那一条视图也收起（裁定⑱）。
   *
   * 用「重建为占位页」而不是「摘掉视图」：视图槽位是界面布局的一部分（1.2-12），
   * 摘掉之后 resize 就无处摆位，重新打开还得再走一遍创建逻辑。
   * 接管进来的新标签属于这个站点页面，一并关掉——否则「关」之后它们还是活的视图目标。
   */
  unmountKernelSite = (): void => {
    this.recordLifecycle(`unmountKernelSite ← ${this.stackBrief(4)}`);
    this.createKernelView();
  };

  /**
   * 交回内嵌内核视图里**当前活动页面**的句柄，供领域层（`browser.page`）读写页面。
   *
   * 视图的**所有权**仍在壳层：壳层负责创建、摆位、销毁，这里只是把句柄借出去。
   * 之所以借句柄而不是在壳层加一堆 `readPage()/click()` 方法：抓取、注入、生成类能力
   * 一律不属于壳（见本文件头注释），而借出去之后它们只可能有一个归属地。
   *
   * 活动页面 = 最上层还活着的接管子视图，没有子视图时才是内核视图本身（spec 2.2-11）：
   * 定位层与动作层必须打在用户真正看到的那一页上，否则会对着被盖住的旧页面点击。
   * @returns 当前活动页面的 `WebContents`；未挂载站点、视图未创建或已全部销毁时为 null（调用方据此结构化失败，不猜）
   */
  kernelContents = (): WebContents | null => {
    // 占位页也占一个视图，但它不是任何平台的会话：把它当句柄交出去，
    // 上层就分不清「没开会话」和「开了会话但页面还没装载」。
    if (this.kernelViewPartition === '') return null;
    return this.activeKernelContents();
  };

  /**
   * 显示/隐藏内嵌内核视图（连同其上的接管子视图，它们是同一块槽位里的页面）。
   *
   * 这是**人用的那只口**（诊断面板的显隐按钮）：默认收起之后它仍然是唯一的越权口子，
   * 允许在挂载着真实站点时把视图暂时收掉；重新挂载站点会把它推回展示（`createKernelView`）。
   * @param visible 目标可见性
   * @returns 生效后的可见性
   */
  setKernelViewVisible = (visible: boolean): { kernelViewVisible: boolean } => {
    this.applyKernelViewVisible(Boolean(visible));
    return { kernelViewVisible: this.kernelViewVisible };
  };

  /**
   * 接住渲染层实测的内核视图槽位几何，立刻按它摆位（spec 8.8-01）。
   *
   * 摆位的权威从「主进程按固定比例硬铺」换成「渲染层量出来的那一块」：原生视图只有铺在渲染层
   * 真正为它留的位置上，才既盖不住顶部标题栏与底部状态条，也才铺得出真实站点的桌面布局
   * （6.2-04 / 6.4-04 记的就是这块：右栏 456px 且没有调整口，界面侧改不动，得主进程配合）。
   * @param rect 渲染层 `getBoundingClientRect()` 的读数（DIP，原点是客户区左上角）
   * @returns 摆位之后的状态快照，调用方当场核对 `kernelViewBounds` 有没有落成自己报的那块
   * @throws 读数非有限、尺寸非正、或与客户区无交集时 `KERNEL_VIEW_BOUNDS_INVALID`（保留上一份摆位，不铺 0×0）
   */
  setKernelViewBounds = (rect: KernelViewRect): ShellStatus => {
    const win = this.mainWindow;
    const content = win?.getContentBounds() ?? { width: 0, height: 0 };
    const clamped = clampSlotRect(rect, { width: content.width, height: content.height });
    if (!clamped) {
      throw new AppError(
        'KERNEL_VIEW_BOUNDS_INVALID',
        `槽位几何不合法：x=${String(rect.x)} y=${String(rect.y)} ${String(rect.width)}×${String(rect.height)}`,
        'shell',
        { rect, content: { width: content.width, height: content.height } },
      );
    }
    this.slotRect = clamped;
    this.layoutKernelView();
    return this.getStatus();
  };

  /**
   * 设置内核视图缩放（11-04）：`zoom = min(1, 视图宽 / 平台 minLayoutWidth)`。
   *
   * 与 `setKernelViewBounds` 同一族：几何与比例由渲染层在同一条 observer 回调里算完一起报，
   * 主进程只负责校验与落库。非法值（非有限、≤0、>1）一律结构化失败并**保留上一份**，
   * 不让一个 NaN 把页面缩成看不见的尺寸。
   * @param zoom 渲染层算好的比例（不可信输入）
   * @returns 应用后的状态快照
   * @throws 非法值时 `KERNEL_VIEW_ZOOM_INVALID`
   */
  setKernelViewZoomFactor = (zoom: number): ShellStatus => {
    const clamped = clampZoomFactor(zoom);
    if (clamped === null) {
      throw new AppError(
        'KERNEL_VIEW_ZOOM_INVALID',
        `缩放值不合法：${String(zoom)}（必须是 (0,1] 的有限数）`,
        'shell',
        {
          zoom,
          previous: this.zoomFactor,
        },
      );
    }
    this.zoomFactor = clamped;
    this.applyZoomFactor();
    return this.getStatus();
  };

  /**
   * 在系统文件管理器里选中主进程刚写出来的那份产物（spec 6.2-12，09 稿 1-B 的第二段动作）。
   *
   * 这是全项目唯一一条"参数指向磁盘"的白名单口，所以边界判定写在 `reveal-target.ts`：
   * 只认 `userData` 之内、且磁盘上真存在的路径。`showItemInFolder` 在 Electron 44 返回 `void`，
   * 成功与否拿不到库的读数，因此判不过就抛结构化错误，而不是静默返回成功让界面按了什么都没发生。
   * @param filePath 渲染层递来的绝对路径（只该是导出 PDF 这类主进程自己写的产物）
   * @returns `{ revealed: true }`；越界 → `REVEAL_OUTSIDE_USER_DATA`，文件已不在 → `REVEAL_TARGET_MISSING`
   */
  revealInFolder = (filePath: string): { revealed: true } => {
    const target = resolveRevealTarget(filePath, app.getPath('userData'));
    if (!target.isAccepted) throw new AppError(target.code, target.reason, 'shell.revealInFolder', {});
    electronShell.showItemInFolder(target.resolvedPath);
    return { revealed: true };
  };

  /**
   * 把人正看的那份 PDF 交给本机另一个应用（Office-cc）整页编辑（spec 3.15，plan `03-resume-pdf` §21，裁定㊴ 的 A 形状）。
   *
   * 这一颗**不写本 app 的任何状态**：不改文档、不落文件、不回读结果——它做的只是
   * 「把一条已经存在的路径交给操作系统」，与上面的 `revealInFolder` 同类，
   * 所以它不构成 3.13-01 / 3.13-03 钉的那种写口（这一句读法是 plan §21.3 第 2 条定的，不是事后补的说法）。
   * 拉起走伴生应用自己声明为稳定的 CLI 契约（`officecc --json open <绝对路径> [--page n]`），
   * argv 用数组、**不经 shell**（§8.1）；入参形状、回执映射与超时全在 `companion-editor.ts` 里判，
   * 这里只把拒绝抛成结构化错误——四道失败各有各的码，为的是界面那四句人话给的下一步不一样。
   * @param filePath 未受信的渲染层实参：那份 PDF 的绝对路径（必须是绝对路径且以 `.pdf` 结尾，判定在主进程）
   * @param page 未受信的渲染层实参：人此刻正看的那一页（**1 起**，与 CLI 的 `--page` 同一口径）；
   *             不是正整数就整支不带——页号只是「帮我翻到那一页」，不值得为它失败一次跳转
   * @returns `{ openedPath }`：交出去的那一条绝对路径，让界面说得清交的是哪一份；
   *          失败是 `INVALID_ARGUMENT`（形状不对）、`COMPANION_EDITOR_MISSING`（本机没装）、
   *          `COMPANION_EDITOR_REJECTED`（它按自己的 reason 拒了）、`COMPANION_EDITOR_TIMEOUT`（等不到）、
   *          `COMPANION_EDITOR_FAILED`（答得不成 `--json` 那个形状）之一
   */
  openInCompanionEditor = async (filePath: unknown, page?: unknown): Promise<{ openedPath: string }> => {
    const plan = planCompanionOpen(filePath, page);
    if (!plan.isAccepted) throw new AppError(plan.code, plan.reason, 'shell.openInCompanionEditor');
    const command = resolveCompanionCommand(this.config.companionEditorBin, process.env);
    if (command === undefined)
      throw new AppError(
        'COMPANION_EDITOR_MISSING',
        `本机找不到伴生应用的命令行：${this.config.companionEditorBin}`,
        'shell.openInCompanionEditor',
        { bin: this.config.companionEditorBin },
      );
    const reply = await launchCompanion(command, plan.args);
    if (!reply.isAccepted) throw new AppError(reply.code, reply.reason, 'shell.openInCompanionEditor', reply.details);
    return { openedPath: plan.filePath };
  };

  /**
   * 请操作系统弹出「打开文件」面板，把人选中的路径回给渲染层（简历导入与 PDF 打开的唯一入口）。
   *
   * 渲染层在 sandbox 下读不了文件系统（§8.1），而"敲绝对路径"这条路在界面上根本走不通——
   * 路径打不出来，导入与打开就永远是禁用态。这里只回路径本身，不读文件内容、不返回目录。
   * `multiple` 为真时允许一次选中多份（简历批量导入），仍只开放文件选择、不开放目录选择。
   * @param raw 未受信的渲染层实参：标题（已由 i18n 翻好）、筛选器与多选开关；形状判定在 `file-picker.ts`
   * @returns `{ filePath, filePaths }`；人取消时两者为空（取消不是失败，界面据此保持原状而不报错）
   */
  selectFile = async (raw: unknown): Promise<{ filePath: string | null; filePaths: string[] }> => {
    const decision = decideOpenPicker(raw, 3);
    if (!decision.isAccepted)
      throw new AppError('INVALID_ARGUMENT', `文件选择器参数不合法：${decision.reason}`, 'shell');
    const win = this.mainWindow;
    const properties: Array<'openFile' | 'multiSelections'> = decision.options.multiple
      ? ['openFile', 'multiSelections']
      : ['openFile'];
    const reply =
      win === undefined
        ? await dialog.showOpenDialog({
            properties,
            title: decision.options.title,
            filters: decision.options.filters,
          })
        : await dialog.showOpenDialog(win, {
            properties,
            title: decision.options.title,
            filters: decision.options.filters,
          });
    if (reply.canceled) return { filePath: null, filePaths: [] };
    return { filePath: reply.filePaths[0] ?? null, filePaths: reply.filePaths };
  };

  /**
   * 请操作系统弹出「另存为」面板，把人选中的落点回给渲染层（PDF 轻编辑的另存与备份导出用）。
   * @param raw 未受信的渲染层实参：标题、筛选器与建议文件名（文件名不许带路径分隔符，判定在 `file-picker.ts`）
   * @returns `{ filePath }`；人取消时为 null
   */
  selectSaveFile = async (raw: unknown): Promise<{ filePath: string | null }> => {
    const decision = decideSavePicker(raw, 3);
    if (!decision.isAccepted) throw new AppError('INVALID_ARGUMENT', `另存为参数不合法：${decision.reason}`, 'shell');
    const win = this.mainWindow;
    const reply =
      win === undefined
        ? await dialog.showSaveDialog({
            defaultPath: decision.options.defaultPath,
            title: decision.options.title,
            filters: decision.options.filters,
          })
        : await dialog.showSaveDialog(win, {
            defaultPath: decision.options.defaultPath,
            title: decision.options.title,
            filters: decision.options.filters,
          });
    return { filePath: reply.canceled ? null : (reply.filePath ?? null) };
  };

  /**
   * 把目标可见性落到视图上，并在值真的变了时推一条 `shell/kernel-view-visible`。
   *
   * 可见性只有这一处出口：`setKernelViewVisible`（人按的）与 `createKernelView`（装的是什么）
   * 都会走到这里，界面那一栏才知道该收起还是该让出那 38%（AGENTS.md §2.2，同一逻辑的第二处必须抽）。
   * @param visible 目标可见性
   */
  private applyKernelViewVisible = (visible: boolean): void => {
    // 没有活视图时**不许**把「可见」置真（2026-11-23 的 P1）：否则状态读数变成
    // `visible:true / url:"" / partition:""` 的幽灵态，用户点「展开网页窗口」只会看到一片空白，
    // 而地址栏据此以为有页面。可见性的事实只能跟着视图走。
    if (visible && liveWebContentsOf<WebContents>(this.kernelView) === null) {
      this.ctx.logger.warn('没有活着的内核视图：拒绝把视图置为可见（避免幽灵可见态）');
      this.kernelViewVisible = false;
      return;
    }
    const changed = this.kernelViewVisible !== visible;
    this.kernelViewVisible = visible;
    this.kernelView?.setVisible(visible);
    // 子视图不跟着隐藏的话，隐藏内核视图后新标签还浮在界面上，等于一个关不掉的浮层。
    this.takeoverViews.forEach((view) => view.setVisible(visible));
    // 新建的 view 默认尺寸是 0x0：不显式摆位就永远看不见，所以摆位跟着可见性一起落，不等 resize 来救。
    this.layoutKernelView();
    // 幂等的那几次不叫醒订阅方：界面读数与状态条不需要为同一次挂载重画两遍。
    if (changed) this.ctx.emit('shell/kernel-view-visible', visible);
  };

  /** 仅开发态可用：在主进程内抛一次异常，用于验收「主进程出错不静默死窗」。 */
  probeMainCrash = (): never => {
    if (app.isPackaged) throw new Error('probeMainCrash 只在开发态开放');
    throw new Error('deliberate main-process failure');
  };

  /**
   * 无人值守被风控暂停时在托盘与系统通知里各留一条（spec 10.6-04）。
   *
   * 系统通知不可用（未授权、平台不支持）不构成静默放行：托盘提示与 tooltip 仍然改，界面横幅照常出现；
   * 这里只负责「人回到桌面先看到哪一句」，不参与任何外发判定。
   * @param event 授权服务发来的暂停载荷（平台 + 原因原文 + 时刻）
   */
  private notifyAuthorizationPaused(event: AuthorizationPausedEvent): void {
    const title = '无人值守投递已暂停';
    this.tray?.setToolTip(`auto-cc · ${title}：${event.reason}`);
    // macOS 的托盘文字位能挂一个字，Windows/Linux 没有这个概念，所以只在 darwin 上设。
    if (process.platform === 'darwin') this.tray?.setTitle('!');
    const notificationSupported = Notification.isSupported();
    if (notificationSupported) new Notification({ title, body: event.reason }).show();
    // 进程侧读数（spec 10.6-04 的 V 取证退路）：托盘是原生层，截不到像素时至少要能证明
    // 「托盘已建、tooltip 已写、通知通道被调用」这三件事发生过——日志里如实带平台与是否支持通知。
    this.ctx.logger.info(
      `授权暂停通知：platform=${event.platform} · tray=${this.tray ? 'created' : 'missing'} · ` +
        `tooltip=set · notification=${notificationSupported ? 'shown' : 'unsupported'}`,
    );
    // 同一份读数再写一行 console：托盘属于原生层，V 取证拿不到像素时只能读进程侧输出（spec 10.6-04 的退路）。
    console.info(
      `[shell] 授权暂停通知：platform=${event.platform} · tray=${this.tray ? 'created' : 'missing'} · ` +
        `tooltip=set · notification=${notificationSupported ? 'shown' : 'unsupported'}`,
    );
  }

  /** 把主窗口唤到前台（单实例锁下第二次启动时调用）。 */
  focusMainWindow = (): void => {
    const win = this.mainWindow;
    // 窗口可能已被销毁（见 createWindow 的 closed 分支）：此时重建而不是戳一个死对象。
    if (!win || win.isDestroyed()) {
      this.createWindow();
      return;
    }
    if (!win.isVisible()) win.show();
    win.focus();
  };

  /** 记录主进程侧最近一次错误，供渲染层展示可见错误态。 */
  /**
   * 取一段短栈（只留前若干帧），用于把「谁销毁了视图」这条线索送到看得见的地方。
   *
   * 为什么要把栈塞进 `lastError` 而不只打日志：2026-11-23 的压测里 QA 的 `lastError` 明明有值，
   * 日志里却一条都没有——说明「日志通道」和「读数通道」不是同一条，靠日志等根因会白等。
   * 栈经过 `getStatus().lastError` 回来时，一定能到读数的人手里。
   * @param limit 最多保留几帧（默认 8：够认出调用方，又不至于把日志冲成一片）
   * @returns 单行化后的栈；取不到时给占位
   */
  private recordLifecycle = (what: string): void => {
    this.kernelLifecycle.push(`${new Date().toISOString()} ${what}`);
    if (this.kernelLifecycle.length > 12) this.kernelLifecycle.shift();
  };

  /**
   * 把「销毁栈 + 销毁前壳层做了什么」拼成一段可读现场。
   * @returns 单行现场文本（栈 + `before:` 尾迹）
   */
  private goneScene = (): string => `${this.stackBrief()}｜before: ${this.kernelLifecycle.join(' > ') || '（无记录）'}`;

  private stackBrief = (limit = 8): string => {
    const stack = new Error('kernel-view-gone').stack ?? '';
    const frames = stack
      .split('\n')
      .slice(1, limit + 1)
      .map((line) => line.trim())
      .join(' <- ');
    return frames === '' ? '（无栈）' : frames;
  };

  private noteError = (error: unknown): void => {
    this.lastError = error instanceof Error ? error.message : String(error);
    console.error('[shell] main-process error:', this.lastError);
  };

  /** 等待 app ready 后建立窗口、视图与托盘。 */
  private async launch() {
    process.on('uncaughtException', this.noteError);
    process.on('unhandledRejection', this.noteError);
    await app.whenReady();
    this.createWindow();
    this.createTray();
    // 无人值守被风控暂停时，托盘与系统通知各留一条（spec 10.6-04 的「托盘可见」）：
    // 界面横幅由渲染层订阅同一条事件，两处读的是同一份原因原文，不各写一句（§2.7）。
    const offAuthorizationPaused = this.ctx.on('outbound/authorization-paused', (event) =>
      this.notifyAuthorizationPaused(event),
    );
    this.ctx.effect(() => offAuthorizationPaused, 'shell.authorization-paused');
    // 单实例锁由 main 入口持有；这里只负责把第二次启动引到已有窗口上。
    app.on('second-instance', () => this.focusMainWindow());
    app.on('before-quit', () => {
      this.quitting = true;
    });
    // 关闭主窗口收进托盘，因此不能按默认行为退出。
    app.on('window-all-closed', () => {});
  }

  /**
   * 仅开发态可用：写一条带敏感字段的日志，回读与实时展示分别走 `log.tail` 与 `log/line` 事件，
   * 用来在界面上验收 1.3-11（出口脱敏对结构化字段与自由文本都生效）。
   */
  probeRedact = (): { written: true } => {
    if (app.isPackaged) throw new Error('probeRedact 只在开发态开放');
    this.ctx.logger.warn('登录失败 token=abc123 状态 500', {
      authorization: 'Bearer x.y.z',
      phone: '13800001111',
      email: 'zhangsan@qq.com',
    });
    return { written: true };
  };

  /** 创建主窗口并挂载内嵌内核视图。 */
  private createWindow() {
    // 启动尺寸可由 `AUTO_CC_WINDOW_SIZE`（如 `1024x768`）指定：31 的三档取证必须走真实窗口，
    // 而 CDP 的 Emulation 改的是页面视口、不是窗口（用它判「视图与页面同步」等于自证）。非法值退回默认。
    const requested = parseWindowSize(process.env.AUTO_CC_WINDOW_SIZE);
    if (process.env.AUTO_CC_WINDOW_SIZE !== undefined && requested === null) {
      this.ctx.logger.warn(
        `AUTO_CC_WINDOW_SIZE 非法（${process.env.AUTO_CC_WINDOW_SIZE}），按默认 ${String(DEFAULT_WINDOW_SIZE.width)}×${String(DEFAULT_WINDOW_SIZE.height)} 起窗口`,
      );
    }
    const size = requested ?? DEFAULT_WINDOW_SIZE;
    const win = new BrowserWindow({
      width: size.width,
      height: size.height,
      show: false,
      title: 'auto-cc',
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        // app 界面独占一个分区：站点 cookie 与界面 cookie 从此在两套磁盘存储里（spec 1.8-02）。
        partition: APP_PARTITION,
      },
    });
    this.mainWindow = win;

    this.createKernelView();

    win.once('ready-to-show', () => {
      win.show();
      this.layoutKernelView();
    });
    win.on('resize', this.layoutKernelView);
    // 关闭不退出，收进托盘；真正的退出由托盘菜单或 before-quit 决定。
    win.on('close', (event) => {
      if (this.quitting) return;
      event.preventDefault();
      win.hide();
    });
    // 实测：渲染层 `window.close()` 不吃 close 的 preventDefault，窗口会被真销毁。
    // 销毁后立刻重建，「关窗不退出」才在 X 按钮和页面自关闭两条路径上都成立。
    win.on('closed', () => {
      if (this.mainWindow !== win) return;
      this.mainWindow = undefined;
      this.kernelView = undefined;
      // 子视图随窗口的 contentView 一起没了：表不清空的话 `kernelViewTakeoverCount` 会停在旧值上。
      this.takeoverViews = [];
      if (!this.quitting) this.createWindow();
    });
    // 安全底线：应用内一律不开新窗口，外链交出去也要显式放行。
    win.webContents.setWindowOpenHandler(({ url }) => {
      console.warn(`[shell] 已拒绝窗口打开请求：${url}`);
      return { action: 'deny' };
    });
    win.webContents.on('did-fail-load', (_e, code, description) => this.noteError(`${code} ${description}`));
    this.observeAssistantHotkey(win.webContents);

    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (devUrl) void win.loadURL(devUrl);
    else void win.loadFile(rendererIndexPath);
  }

  /**
   * 建立或重建内嵌内核视图，并顺手把可见性落到「装的是不是真实站点」上（裁定⑱）。
   * @param partition 会话分区名；省略就是占位页（非持久会话，不需要落盘），此时视图收起
   * @param url 要加载的地址，默认还是 1.2 的占位页
   */
  private createKernelView(partition?: string, url = kernelViewPlaceholder) {
    const win = this.mainWindow;
    if (!win) return;
    this.recordLifecycle(`createKernelView partition=${partition ?? '(placeholder)'}`);
    // 接管子视图挂在旧页面之上：旧页面一换，它们就无处可依，必须一起收掉（2.1-11 的泄漏口径）。
    [...this.takeoverViews].forEach((view) => this.detachTakeoverView(view));
    const previous = this.kernelView;
    const previousContents = liveWebContentsOf<WebContents>(previous);
    if (previous && previousContents) {
      // 摘旧视图这一步**不许中断重建**：它抛了也要继续把新视图建起来并指过去，
      // 否则场上会留一个「引用还在、webContents 已死」的坑（之后每次读状态都踩它）。
      this.remounting = true;
      // 调用点栈（2026-11-23，QA 的要求）：`destroyed` 监听器里的栈只有两帧，指不出调用方；
      // 真正有用的是**关旧视图这一刻**的栈——它带着 `createKernelView` 的调用者
      // （`mountKernelSite` / `unmountKernelSite` / `sessions.open` / `ensureBrowser`）。
      this.recordLifecycle(`closing previous kernel view ← ${this.stackBrief(5)}`);
      try {
        win.contentView.removeChildView(previous);
        // `close()` 而不是 `forceUnload()`：后者只停页面，webContents 仍留在 Electron 的目标表里，
        // harness 与 devtools.status() 就会数到一个看不见的僵尸目标（1.6-06 的对照会错位）。
        previousContents.close();
      } catch (error) {
        this.ctx.logger.warn(
          `摘旧内核视图时出错（继续重建新视图）：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const view = new WebContentsView({
      webPreferences: {
        ...(partition === undefined ? {} : { partition }),
        // 视图里跑的是外部站点，三条安全底线必须显式成立，不能指望默认值（AGENTS.md §8.1）。
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    this.kernelView = view;
    this.recordLifecycle('new kernel view assigned');
    // 新视图已经就位：此后旧视图再来的 destroyed 走不到「当前视图」那条判据，标记也可以落了。
    this.remounting = false;
    // Electron 44 的 `Session` 类型上没有 partition 读取口（只有构造时的 `webPreferences.partition`），
    // 所以分区名由创建处记下；视图重建必然带上新值，读数不会停在旧分区。
    this.kernelViewPartition = partition ?? '';
    if (partition !== undefined && partition !== '') this.lastKernelPartition = partition;
    this.kernelViewError = null;
    // 新视图建起来 = 上一次的「视图没了」已经过去了；那条读数不能跟着新视图继续显示（P2）。
    this.kernelViewGone = null;
    this.kernelViewGoneStack = null;
    win.contentView.addChildView(view);
    // 「需要时才展示」的判据就这一条：装的是真实站点就展示，装的是占位页就收起。
    // 规则写在视图的拥有者这里，而不是让每个挂载方各补一句 `setKernelViewVisible(true)`（§2.5）。
    this.applyKernelViewVisible(this.kernelViewPartition !== '');
    // 新建的 view 默认尺寸是 0x0：渲染层报来首份矩形之前不铺位（11-03），报来之后由 observer 推。
    this.layoutKernelView();
    this.applyZoomFactor();
    // 失败读数与窗口打开的处理对父视图和接管子视图是同一条，收进两个小方法里（AGENTS.md §2.2）。
    this.observeKernelViewGone(view);
    this.installCloseGuard(view);
    this.observeLoadFailure(view.webContents);
    this.observeKernelViewUrl(view);
    this.observeAssistantHotkey(view.webContents);
    view.webContents.setWindowOpenHandler(({ url }) => this.handleWindowOpen(view.webContents, url));
    void view.webContents.loadURL(url);
  }

  /**
   * 盯住「内核视图自己没了」这件事（2026-11-23 的 P1）：
   * 真站在筛选下拉上点一下就能让这个页面从 CDP 目标表里消失，而壳层还握着它的记位。
   *
   * 两条入口都接：`destroyed`（页面被关闭/被销毁）与 `render-process-gone`（渲染进程崩了）。
   * 收到就**立刻收尸 + 记一行原因**：原因（`reason` / `exitCode`）是下次复现时唯一能定位根因的读数，
   * 所以随日志与 `lastError` 一起留下，不吞。
   * @param view 刚建好的内核视图
   */
  private observeKernelViewGone(view: WebContentsView): void {
    const contents = liveWebContentsOf<WebContents>(view);
    if (!contents) return;
    contents.on('destroyed', () => {
      // 换视图期间的 destroyed 一律是正常替换（见 `remounting` 的注释）。
      if (this.remounting) return;
      // 其余情况只有**当前**视图被销毁才算故障（旧视图迟到的 destroyed 也不算）。
      if (this.kernelView !== view) return;
      // 栈既进 lastError（读数通道）、又打 console（日志通道）：本轮实测两条通道不是同一条，
      // 只打日志会出现「lastError 有值、日志为空」，那就永远等不到根因。
      this.kernelViewGoneStack = this.goneScene();
      this.kernelViewGone = '内核视图的页面被销毁';
      console.error('[shell] kernel view destroyed:', this.kernelViewGoneStack);
      this.ctx.logger.warn(`${this.kernelViewGone}｜${this.kernelViewGoneStack}`);
      const urlBeforeGone = this.lastKernelUrl;
      this.reapDeadKernelView();
      // 兜底恢复（限流）：站点把页面关了之后按原地址接回来，用户不至于看到右栏突然空掉。
      this.attemptRecovery(urlBeforeGone);
    });
    contents.on('render-process-gone', (_event, details) => {
      if (this.remounting) return;
      if (this.kernelView !== view) return;
      this.kernelViewGoneStack = `reason=${details.reason} exitCode=${String(details.exitCode)}｜${this.goneScene()}`;
      this.kernelViewGone = `内核视图的渲染进程退出：reason=${details.reason} exitCode=${String(details.exitCode)}`;
      console.error('[shell] kernel view crashed:', this.kernelViewGoneStack);
      this.ctx.logger.error(this.kernelViewGone);
      this.reapDeadKernelView();
    });
  }

  /**
   * 反自关：把站点自己的 `window.close()` / `self.close()` 换成空操作，并记一次计数。
   *
   * 为什么是我们做（2026-11-23 管理员裁定）：视图是我们这扇窗，宿主有权决定它不被页面关掉；
   * 注入只跑在**我们自己的**内核视图里，不挂 preload、不动 `contextIsolation` / `sandbox`，
   * 也不代表站点做任何动作——它是「别关我这扇窗」，不是「替你点按钮」。
   *
   * 计数走**哨兵日志**：页面里被拦下时打一条 `[auto-cc:close-blocked]`，主进程按这条消息累加。
   * 这样计数不需要渲染层配合，也不会因为页面上下文刷新而丢（每次导航都会重新注入）。
   * @param view 刚建好的内核视图
   */
  private installCloseGuard(view: WebContentsView): void {
    const contents = liveWebContentsOf<WebContents>(view);
    if (!contents) return;
    const script = `(() => {
      if (window.__autoCCCloseGuard) return true;
      window.__autoCCCloseGuard = true;
      const block = () => { try { console.warn('[auto-cc:close-blocked]'); } catch {} };
      try { window.close = block; } catch {}
      try { self.close = block; } catch {}
      return true;
    })()`;
    const inject = (): void => {
      void contents.executeJavaScript(script, true).catch(() => {
        // 注入失败不是故障：站点 CSP 极少数会拦，页面照常可用，只是反自关不生效。
      });
    };
    contents.on('dom-ready', inject);
    contents.on('did-navigate', inject);
    contents.on('console-message', (event) => {
      const message = typeof event?.message === 'string' ? event.message : '';
      if (!message.includes('[auto-cc:close-blocked]')) return;
      this.closeAttempts += 1;
      this.recordLifecycle(`close-blocked ×${String(this.closeAttempts)}`);
    });
  }

  /**
   * 视图被站点关掉之后的兜底恢复（2026-11-23 裁定）：按当时的地址栏 URL 重建一次，限流 ≤2 次/60s。
   *
   * 为什么恢复不能替代根因：它是「右栏突然空了」的体验兜底，不是修好站点行为；
   * 反自关是否真能挡住，由 A/B 的 `kernelViewCloseAttempts` 读数判。
   * 为什么必须限流：站点可能一加载就再关一次，不限流就是重建→再关→再重建的无限循环。
   * @param url 站点关掉页面之前的那条地址（`destroyed` 之后 `getURL()` 已读不到，用最近一次记录）
   */
  private attemptRecovery = (url: string): void => {
    const now = Date.now();
    const verdict = recoveryVerdict(this.recoveries, now);
    if (!verdict.allowed) {
      this.ctx.logger.warn(`恢复预算用尽（${String(verdict.usedInWindow)} 次/窗口）：不再重建，等用户点重试`);
      this.ctx.emit('shell/kernel-view-recovery', { status: 'exhausted', url, attempt: verdict.usedInWindow });
      return;
    }
    if (url === '' || this.lastKernelPartition === '') {
      // 没有可回去的地址：什么都不做，让界面显示「没有视图」（这是之前的既有行为）。
      return;
    }
    this.recoveries = withRecovery(this.recoveries, now);
    const attempt = this.recoveries.length;
    this.recordLifecycle(`recover view after site close → ${url}`);
    this.ctx.logger.warn(`内核视图被站点关掉，按原地址重建（本窗口第 ${String(attempt)} 次）：${url}`);
    this.createKernelView(this.lastKernelPartition, url);
    this.ctx.emit('shell/kernel-view-recovery', { status: 'recovered', url, attempt });
  };

  /**
   * 人工「重新打开」：把视图按最近一次已知地址重建一次（2026-11-23 裁定②：上限态必须给真控件）。
   *
   * 与自动恢复的区别：这条由人按，所以**不受 60 秒 2 次的限流约束**——限流是为了防自动无限循环，
   * 不是为了让用户在上限后无路可走。按下即清空限流窗口，并把视图按原地址接回来。
   * @returns 重建之后的壳层状态；没有可回去的地址时什么都不做（调用方按读数判断）
   */
  recoverKernelView = (): ShellStatus => {
    const url = this.lastKernelUrl;
    const partition = this.lastKernelPartition;
    if (url === '' || partition === '') {
      this.ctx.logger.warn('没有可回去的地址：不重建（先打开一个会话或输一个网址）');
      return this.getStatus();
    }
    this.recoveries = [];
    this.recordLifecycle(`manual recover by user → ${url}`);
    this.ctx.logger.info(`用户点了「重新打开」：按原地址重建内核视图 ${url}`);
    this.createKernelView(partition, url);
    return this.getStatus();
  };

  /**
   * 收掉已经死掉的内核视图记位（2026-11-23 的 P1 的**自愈**那一半）。
   *
   * 视图死了之后如果还把 `kernelView` 与分区名留着，下一次导航会拿到「没有句柄」的洞：
   * 地址栏照旧的页面地址、`sessions.ensureBrowser()` 又因为在「已有会话」而提前返回，
   * 用户看到的就是「右栏废了、输网址也不动」。所以这里把记位清成「没有视图」：
   * 下一次导航会自己起一个新浏览器会话（`sessions.ensureBrowser`），右栏跟着回来。
   * 只在真的死了的时候动手；活着时是零副作用的判空。
   */
  private reapDeadKernelView = (): void => {
    if (!this.kernelView) return;
    if (isViewLive(this.kernelView)) return;
    this.recordLifecycle('reapDeadKernelView');
    // 走到这里说明「当前视图的 webContents 已不可用」。如果是从 `destroyed` 事件进来的，
    // `kernelViewGone` 里已经有栈；如果是 `getStatus()` 这一侧先发现（事件没来、句柄直接变 undefined），
    // 就在这儿补一条栈——这是唯一还能拿到调用方的地方。
    if (this.kernelViewGone === null) {
      this.kernelViewGone = `内核视图的 webContents 已不可用｜${this.stackBrief()}`;
      console.error('[shell] kernel view vanished:', this.kernelViewGone);
    }
    this.ctx.logger.warn('内核视图已失效（页面销毁或进程退出）：清掉视图记位，下一次导航会重开一个');
    this.kernelView = undefined;
    this.kernelViewPartition = '';
    this.kernelViewVisible = false;
    this.zoomFactor = 1;
    for (const view of [...this.takeoverViews]) this.detachTakeoverView(view);
    this.ctx.emit('shell/kernel-view-visible', false);
  };

  /**
   * 监听一个视图主帧的装载失败，记进当前挂载的失败读数并推 `shell/view-error`。
   *
   * 读数不在「加载成功」事件里复位：实测 `dom-ready` / `did-finish-load` 在失败那一轮也会触发，
   * 任何判据都会把刚记下的错误抹掉，所以它的生命周期就是本次挂载（创建视图时清零，重新打开即复位）。
   * @param contents 要监听的页面句柄（内核视图本身或接管子视图）
   */
  private observeLoadFailure(contents: WebContents): void {
    contents.on('did-fail-load', (_event, code, description, failedUrl, isMainFrame) => {
      if (!isMainFrame) return;
      this.kernelViewError = { code, description, url: failedUrl };
      // 界面不能靠 `sessions.open` 的返回值看到它：那次调用先返回、失败事件后到，读数还是空的。
      this.ctx.emit('shell/view-error', this.kernelViewError);
      this.noteError(`内核视图加载失败 ${code} ${description} @ ${failedUrl}`);
    });
  }

  /**
   * 监听内核视图主帧的地址变化，变了才推 `shell/kernel-view-url`（spec 10.11-29⑤）。
   *
   * 为什么需要它：地址栏在「面板已经开着、站点后来才被打开」时，既收不到 `kernel-view-visible`（值没变），
   * 也不会失去焦点，于是停在占位 `data:` 页上，按刷新被协议闸拒（本轮实测）。去重判据单独成函数并有负对照，
   * 免得同一次装载连发几条把界面刷成事件风暴。
   * @param view 刚建好的内核视图（接管子视图不在这里：它是父页之上的一层，不改变地址栏指向的地址）
   */
  private observeKernelViewUrl(view: WebContentsView): void {
    const push = (next: string): void => {
      if (view !== this.kernelView) return;
      this.lastKernelUrl = next;
      const decision = markKernelViewUrl(this.pushedKernelViewUrl, next);
      this.pushedKernelViewUrl = decision.previous;
      if (decision.emit) this.ctx.emit('shell/kernel-view-url', next);
    };
    // 主帧导航与页内导航（hash / history.pushState）都算地址变化；子帧不算。
    view.webContents.on('did-navigate', (_event, url) => push(url));
    view.webContents.on('did-navigate-in-page', (_event, url) => push(url));
  }

  /**
   * 让人在**任何一块页面**上按 Ctrl/⌘+J 都能呼出助手（spec 10.11-13 / 14，2026-11-22 阻塞项）。
   *
   * 为什么在壳层接：内核站点是独立的 `WebContentsView`，用户一点进站点（滚动、看岗位），键盘焦点就归它，
   * 渲染层挂在主窗口 `window` 上的 `keydown` 收不到——而「站点全屏时呼出助手」恰恰是最需要这个键的时刻。
   * 只在 `keyDown`（且非自动重复）上接；**Esc 不接**：站点自己的 Esc 有用，我们不去抢。
   * @param contents 要监听的页面句柄（主窗口、内核视图、接管子视图各挂一份）
   */
  private observeAssistantHotkey(contents: WebContents): void {
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.isAutoRepeat) return;
      if (!(input.control || input.meta) || input.key.toLowerCase() !== 'j') return;
      // 拦下来再回推：不 preventDefault 的话站点自己也会收到这个组合键（真实站点里 Ctrl+J 是下载）。
      event.preventDefault();
      this.ctx.emit('shell/assistant-toggle', true);
    });
  }

  /**
   * 处理内核视图（及其接管子视图）里的 `window.open` / target=_blank。
   *
   * 一律 deny（AGENTS.md §8.1：外部页面不许自己开窗口），同源的那一个改由同分区子视图承载——
   * 新标签于是既留在我们的视图里、又共用同一份登录态（spec 2.2-11，plan §9.4 Q4 本机实测）。
   * 与主窗口那条 handler 的分工是刻意的：主窗口装的是 app 界面（分区 `persist:app`），
   * 它的弹窗一页都不该进站点视图，所以那边保持无条件 deny（1.2-09 的证据依赖那条日志）。
   * @param source 发起弹窗的页面句柄，同源判定以它**当下**的地址为准
   * @param rawUrl `HandlerDetails.url`，Chromium 已解析成绝对地址，但对壳层仍是不可信输入
   * @returns 恒为 `{ action: 'deny' }`——本方法从不向 Electron 申请创建窗口
   */
  private handleWindowOpen(source: WebContents, rawUrl: string): { action: 'deny' } {
    const decision = decideTakeover(rawUrl, source.getURL());
    if (decision.isAccepted) {
      this.attachTakeoverView(decision.targetUrl.href);
      this.ctx.logger.info(`新标签已接管进会话分区 ${this.kernelViewPartition}：${decision.targetUrl.href}`);
    } else {
      // 外链继续 deny，但要让人看见（2026-11-22 裁定后不再分模式）：界面据这条给一行通用原因。
      this.ctx.emit('shell/popup-blocked', rawUrl);
      console.warn(`[shell] 已拒绝新窗口：${rawUrl}（${decision.reason}）`);
    }
    return { action: 'deny' };
  }

  /**
   * 把已通过同源准入的地址挂成内核视图之上的子视图（spec 2.2-11）。
   * @param targetUrl `decideTakeover` 放行后的绝对地址（同源、http(s)）
   */
  private attachTakeoverView(targetUrl: string): void {
    const win = this.mainWindow;
    // 没有分区就没有「同一份登录态」这回事：占位页阶段一条接管都不挂，宁可什么都不做。
    if (!win || this.kernelViewPartition === '') return;
    const view = new WebContentsView({
      webPreferences: {
        // 分区沿用父视图那一份：spike 实测同分区子视图直接读到页面的 cookie（plan §9.4 Q4）。
        partition: this.kernelViewPartition,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    this.observeAssistantHotkey(view.webContents);
    // 先入表再上窗口：表是「有几个接管视图」的唯一读数来源（getStatus.kernelViewTakeoverCount）。
    this.takeoverViews.push(view);
    // 追加到 contentView 末尾 = 叠在内核视图之上，正好是「新标签在前台」的语义。
    win.contentView.addChildView(view);
    view.setVisible(this.kernelViewVisible);
    this.layoutKernelView();
    this.applyZoomFactor();
    this.observeLoadFailure(view.webContents);
    // 接管页自己再开新标签也走同一条口：不装 handler 的话那一路就没人管，等于允许逃逸。
    view.webContents.setWindowOpenHandler(({ url }) => this.handleWindowOpen(view.webContents, url));
    // 页面 `window.close()` 时也必须从表和窗口里摘掉，否则 2.1-11 的泄漏计数会一直涨。
    view.webContents.on('destroyed', () => this.detachTakeoverView(view));
    void view.webContents.loadURL(targetUrl);
  }

  /**
   * 摘掉一个接管子视图：移出窗口的子视图列表与内部表，并关掉页面。
   *
   * 主动关闭（换平台 / 收回站点）与页面自杀（`destroyed` 回调）都汇聚到这里，所以必须可重入：
   * 已不在表里的那一个直接返回，免得对同一个视图动手两次。销毁顺序按 plan §9.4 Q5：
   * `removeChildView` + `webContents.close()` 之后该页面才从 CDP 目标表里消失。
   * @param view 要摘掉的接管子视图
   */
  private detachTakeoverView(view: WebContentsView): void {
    const index = this.takeoverViews.indexOf(view);
    if (index < 0) return;
    this.takeoverViews.splice(index, 1);
    this.mainWindow?.contentView.removeChildView(view);
    // destroyed 路径里页面已经没了，再 close() 就是对死句柄动手；只有主动关闭这一条还需要它。
    liveWebContentsOf<WebContents>(view)?.close();
  }

  /**
   * 当前叠在最上层、页面还活着的接管子视图。
   * @returns 活动子视图；无接管视图或全部已销毁时为 null（调用方回落到内核视图本身）
   */
  private activeTakeoverView(): WebContentsView | null {
    return topmostAlive(this.takeoverViews, (view) => isViewLive(view));
  }

  /**
   * 当前活动页面的句柄：栈顶还活着的接管子视图，没有则回落内核视图本身（spec 2.2-11）。
   *
   * `kernelContents()` 与 `getStatus()` 都要这一份"看的是哪一页"的判断，出现两次就收进一处（§2.2）。
   * @returns 活动页面的 `WebContents`；两个候选都不可用（视图未创建或已销毁）时为 null
   */
  private activeKernelContents(): WebContents | null {
    const candidate =
      liveWebContentsOf<WebContents>(this.activeTakeoverView()) ?? liveWebContentsOf<WebContents>(this.kernelView);
    return candidate;
  }

  /**
   * 把当前缩放应用到内核视图与全部接管子视图（11-04）。
   *
   * 接管子视图与父视图同分区同槽位，缩放不一起改就会出现「父页 0.77、子页 1.0」两种字形；
   * 子视图创建时也会补一次（见 `attachTakeoverView`）。
   */
  private applyZoomFactor = () => {
    liveWebContentsOf<WebContents>(this.kernelView)?.setZoomFactor(this.zoomFactor);
    for (const view of this.takeoverViews) liveWebContentsOf<WebContents>(view)?.setZoomFactor(this.zoomFactor);
  };

  /**
   * 给内核视图摆位：渲染层报过槽位就按那块铺（并夹进当前客户区），没报过才退回固定比例兜底；
   * 接管子视图铺同一块槽位。
   *
   * 窗口尺寸变了要重新夹一次：报来的槽位是那一刻的布局，窗口缩小后它可能整块跑到外面去，
   * 夹不住就干脆用兜底那份，也不能让视图停在旧尺寸上露馅（resize 之后渲染层会再报来新读数）。
   */
  private layoutKernelView = () => {
    const win = this.mainWindow;
    if (!win || !this.kernelView) return;
    const { width, height } = win.getContentBounds();
    const content = { width, height };
    // 11-03：首帧没收到渲染层上报就**不铺位**（新视图默认 0×0），不再按 38% 编一块假矩形。
    // 渲染层一报来，`clampSlotRect` 就把旧矩形夹进当前客户区；resize 之后它会再报新读数。
    if (!this.slotRect) return;
    const slot = clampSlotRect(this.slotRect, content);
    if (!slot) return;
    this.kernelView.setBounds(slot);
    // 接管的子视图是「同一个槽位里的新标签」：不跟着摆位的话，resize 后它就停在旧尺寸上露馅。
    this.takeoverViews.forEach((view) => view.setBounds(slot));
  };

  /**
   * 建立托盘图标与菜单。
   * 托盘是原生 UI，不走渲染层的 i18n 资源，因此按系统语言取标签。
   */
  private createTray() {
    const image = nativeImage.createFromPath(iconPath);
    this.tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 }));
    this.tray.setToolTip('auto-cc');
    const zh = app.getLocale().toLowerCase().startsWith('zh');
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: zh ? '显示主窗口' : 'Show window', click: () => this.focusMainWindow() },
        { type: 'separator' },
        { label: zh ? '退出' : 'Quit', click: () => app.quit() },
      ]),
    );
    this.tray.on('click', () => this.focusMainWindow());
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    shell: ShellService;
    update: UpdateService;
  }
}

export { ResumePrintService } from './print-executor.js';
export { decideOpenPicker, decideSavePicker } from './file-picker.js';
export type { FilePickerRequest, SaveFilePickerRequest } from './file-picker.js';
export { armManualOnly, assertManualOnly, UpdateChannel, UpdateService, updateSchema };
export type { AutopilotSwitches, UpdateActionName, UpdateCheckResultLike, UpdateConfig, UpdateRuntime, UpdaterLike };
