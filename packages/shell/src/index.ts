import path from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  shell as electronShell,
  Tray,
  WebContentsView,
  type WebContents,
} from 'electron';
import { AppError, Service, type Context } from '@auto-cc/core';
import {
  APP_PARTITION,
  KERNEL_VIEW_WIDTH_RATIO,
  type KernelViewLoadError,
  type KernelViewRect,
  type ShellStatus,
} from '@auto-cc/shared';
import { z } from 'zod';
import { decideOpenPicker, decideSavePicker } from './file-picker.js';
import { resolveRevealTarget } from './reveal-target.js';
import { clampSlotRect, fallbackSlotRect } from './slot-bounds.js';
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

/** 壳层暂无可选项；strict 让 cordis.yml 里给 shell 写错的键在挂载期就报错。 */
export const shellSchema = z.strictObject({});

/**
 * L1 壳层服务：窗口、托盘、生命周期与内嵌内核视图。
 *
 * 这里是「薄壳」与「业务」的分界：本服务只做窗口/进程级的事，任何抓取、发送、
 * 生成类能力都不允许写进来（那属于 L2/L3 插件）。
 *
 * 渲染层的入站校验自 1.4 起归 `ipc` 网关，shell 不再注册通道，因此声明 `inject: ['ipc']`：
 * 网关的处理器必须在主窗口创建之前就在位，否则首屏调用会撞上「No handler registered」。
 */
export class ShellService extends Service {
  static provide = 'shell';
  static Config = shellSchema;
  static inject = ['ipc'];

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
   * 渲染层报来的槽位矩形（spec 8.8-01）；null = 还没报过，摆位回落到 `KERNEL_VIEW_WIDTH_RATIO` 兜底那份。
   * 只存这一份而不另立"视图应在哪儿"的第二套事实：真正的布局永远在渲染层，这里只是它的一次转述。
   */
  private slotRect: KernelViewRect | null = null;
  private quitting = false;
  private lastError: string | undefined;

  /** 启动窗口/托盘；入站通道由 `ipc` 网关注册，这里只负责界面侧。 */
  constructor(ctx: Context) {
    super(ctx, 'shell');
    void this.launch();
  }

  /** 渲染层 `shell.getStatus` 的实现：返回当前窗口与内核视图状态。 */
  getStatus = (): ShellStatus => {
    const win = this.mainWindow;
    const contents = this.kernelView?.webContents;
    const bounds = this.kernelView?.getBounds() ?? { x: 0, y: 0, width: 0, height: 0 };
    return {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? 'unknown',
      nodeVersion: process.versions.node ?? 'unknown',
      platform: process.platform,
      windowVisible: win?.isVisible() ?? false,
      kernelViewVisible: this.kernelViewVisible,
      kernelViewBounds: bounds,
      // 视图销毁后读不到 session，因此分区名取自本服务记下的那份；占位页阶段就是空串。
      // 接管子视图与父视图**共用同一个分区**（创建时传的就是这份），所以这里不需要另立读数。
      kernelViewPartition: this.kernelView?.webContents.isDestroyed() ? '' : this.kernelViewPartition,
      kernelViewUrl: contents?.getURL() ?? '',
      // 用户实际看到的是栈顶那一个：harness 用它证明接管发生（此时 `kernelViewUrl` 仍停在被盖住的父页）。
      activeKernelViewUrl: this.activeKernelContents()?.getURL() ?? '',
      // 接管子视图的个数：与 `devtools.status().targetCount` 的增量对照，就是 2.1-11 的泄漏判据。
      kernelViewTakeoverCount: this.takeoverViews.length,
      kernelViewLoadError: this.kernelViewError,
      lastError: this.lastError,
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
   * 请操作系统弹出「打开文件」面板，把人选中的那一条路径回给渲染层（简历导入与 PDF 打开的唯一入口）。
   *
   * 渲染层在 sandbox 下读不了文件系统（§8.1），而"敲绝对路径"这条路在界面上根本走不通——
   * 路径打不出来，导入与打开就永远是禁用态。这里只回路径本身，不读文件内容、不返回目录、不允许多选。
   * @param raw 未受信的渲染层实参：标题（已由 i18n 翻好）与筛选器；形状判定在 `file-picker.ts`
   * @returns `{ filePath }`；人取消时为 null（取消不是失败，界面据此保持原状而不报错）
   */
  selectFile = async (raw: unknown): Promise<{ filePath: string | null }> => {
    const decision = decideOpenPicker(raw, 3);
    if (!decision.isAccepted)
      throw new AppError('INVALID_ARGUMENT', `文件选择器参数不合法：${decision.reason}`, 'shell');
    const win = this.mainWindow;
    const reply =
      win === undefined
        ? await dialog.showOpenDialog({
            properties: ['openFile'],
            title: decision.options.title,
            filters: decision.options.filters,
          })
        : await dialog.showOpenDialog(win, {
            properties: ['openFile'],
            title: decision.options.title,
            filters: decision.options.filters,
          });
    return { filePath: reply.canceled ? null : (reply.filePaths[0] ?? null) };
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
    const win = new BrowserWindow({
      width: 1200,
      height: 800,
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
    // 接管子视图挂在旧页面之上：旧页面一换，它们就无处可依，必须一起收掉（2.1-11 的泄漏口径）。
    [...this.takeoverViews].forEach((view) => this.detachTakeoverView(view));
    const previous = this.kernelView;
    if (previous && !previous.webContents.isDestroyed()) {
      win.contentView.removeChildView(previous);
      // `close()` 而不是 `forceUnload()`：后者只停页面，webContents 仍留在 Electron 的目标表里，
      // harness 与 devtools.status() 就会数到一个看不见的僵尸目标（1.6-06 的对照会错位）。
      previous.webContents.close();
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
    // Electron 44 的 `Session` 类型上没有 partition 读取口（只有构造时的 `webPreferences.partition`），
    // 所以分区名由创建处记下；视图重建必然带上新值，读数不会停在旧分区。
    this.kernelViewPartition = partition ?? '';
    this.kernelViewError = null;
    win.contentView.addChildView(view);
    // 「需要时才展示」的判据就这一条：装的是真实站点就展示，装的是占位页就收起。
    // 规则写在视图的拥有者这里，而不是让每个挂载方各补一句 `setKernelViewVisible(true)`（§2.5）。
    this.applyKernelViewVisible(this.kernelViewPartition !== '');
    // 新建的 view 默认尺寸是 0x0：不显式摆位就永远看不见，只有 resize 才会救回来。
    this.layoutKernelView();
    // 失败读数与窗口打开的处理对父视图和接管子视图是同一条，收进两个小方法里（AGENTS.md §2.2）。
    this.observeLoadFailure(view.webContents);
    view.webContents.setWindowOpenHandler(({ url }) => this.handleWindowOpen(view.webContents, url));
    void view.webContents.loadURL(url);
  }

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
    // 先入表再上窗口：表是「有几个接管视图」的唯一读数来源（getStatus.kernelViewTakeoverCount）。
    this.takeoverViews.push(view);
    // 追加到 contentView 末尾 = 叠在内核视图之上，正好是「新标签在前台」的语义。
    win.contentView.addChildView(view);
    view.setVisible(this.kernelViewVisible);
    this.layoutKernelView();
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
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }

  /**
   * 当前叠在最上层、页面还活着的接管子视图。
   * @returns 活动子视图；无接管视图或全部已销毁时为 null（调用方回落到内核视图本身）
   */
  private activeTakeoverView(): WebContentsView | null {
    return topmostAlive(this.takeoverViews, (view) => !view.webContents.isDestroyed());
  }

  /**
   * 当前活动页面的句柄：栈顶还活着的接管子视图，没有则回落内核视图本身（spec 2.2-11）。
   *
   * `kernelContents()` 与 `getStatus()` 都要这一份"看的是哪一页"的判断，出现两次就收进一处（§2.2）。
   * @returns 活动页面的 `WebContents`；两个候选都不可用（视图未创建或已销毁）时为 null
   */
  private activeKernelContents(): WebContents | null {
    const candidate = this.activeTakeoverView()?.webContents ?? this.kernelView?.webContents;
    return candidate && !candidate.isDestroyed() ? candidate : null;
  }

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
    const slot =
      (this.slotRect ? clampSlotRect(this.slotRect, content) : null) ??
      fallbackSlotRect(content, KERNEL_VIEW_WIDTH_RATIO);
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
