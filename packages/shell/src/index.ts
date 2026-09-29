import path from 'node:path';
import { app, BrowserWindow, ipcMain, Menu, nativeImage, Tray, WebContentsView } from 'electron';
import { Service, type Context } from '@auto-cc/core';
import {
  IPC_CHANNELS,
  isAllowedCall,
  KERNEL_VIEW_WIDTH_RATIO,
  type BridgeReply,
  type BridgeRequest,
  type LogLineView,
  type PluginNodeView,
  type ShellStatus,
} from '@auto-cc/shared';
import { z } from 'zod';

/** 仓库根目录（开发态）；打包态由 1.7 换成 resourcesPath。 */
const repoRoot = path.resolve(__dirname, '..', '..', '..');
/** 托盘与窗口图标路径；缺失时退化为空图标，不阻塞启动。 */
const iconPath = path.join(repoRoot, 'resources', 'icon.png');
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
 * L0 服务的最小读取视图。
 *
 * 这里刻意不 import `@auto-cc/plugin-*`：1.4 的 IPC 网关才是跨层读取的正式通道，
 * 在那之前 shell 只需要「读到状态、渲染出来」，用结构类型足够，也不会把 L1 焊死在 L0 上。
 */
interface KernelReader {
  snapshot(): PluginNodeView[];
  manifestError?: string;
}

interface LogReader {
  tail(limit?: number): LogLineView[];
  readonly level: string;
  readonly filePath?: string;
}

/**
 * L1 壳层服务：窗口、托盘、生命周期、内嵌内核视图，以及渲染层桥接的入站校验。
 *
 * 这里是「薄壳」与「业务」的分界：本服务只做窗口/进程级的事，任何抓取、发送、
 * 生成类能力都不允许写进来（那属于 L2/L3 插件）。
 */
export class ShellService extends Service {
  static provide = 'shell';
  static Config = shellSchema;

  private mainWindow: BrowserWindow | undefined;
  private kernelView: WebContentsView | undefined;
  private tray: Tray | undefined;
  private kernelViewVisible = true;
  private quitting = false;
  private lastError: string | undefined;

  /**
   * 装配入口：注册桥接通道并启动窗口。
   *
   * 构造器只接 `ctx`：cordis 挂载 Service 时会把**配置对象**作为第二个实参传进来
   * （`new callback(ctx, config)`），若沿用 `(ctx, name = 'shell')` 就会把配置当服务名注册。
   */
  constructor(ctx: Context) {
    super(ctx, 'shell');
    void this.launch();
  }

  /** 渲染层 `shell.getStatus` 的实现：返回当前窗口与内核视图状态。 */
  getStatus = (): ShellStatus => {
    const win = this.mainWindow;
    const bounds = this.kernelView?.getBounds() ?? { x: 0, y: 0, width: 0, height: 0 };
    return {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? 'unknown',
      nodeVersion: process.versions.node ?? 'unknown',
      platform: process.platform,
      windowVisible: win?.isVisible() ?? false,
      kernelViewVisible: this.kernelViewVisible,
      kernelViewBounds: bounds,
      lastError: this.lastError,
    };
  };

  /**
   * 显示/隐藏内嵌内核视图。
   * @param visible 目标可见性
   * @returns 生效后的可见性
   */
  setKernelViewVisible = (visible: boolean): { kernelViewVisible: boolean } => {
    this.kernelViewVisible = Boolean(visible);
    this.kernelView?.setVisible(this.kernelViewVisible);
    this.layoutKernelView();
    return { kernelViewVisible: this.kernelViewVisible };
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

  /** 等待 app ready 后建立窗口、视图、托盘与桥接通道。 */
  private async launch() {
    process.on('uncaughtException', this.noteError);
    process.on('unhandledRejection', this.noteError);
    this.registerBridge();
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

  /** 仅开发态可用：用一个不在白名单里的调用名走一遍主进程校验，
   * 用来在界面上验收 1.2-05（渲染层拿不到的能力，主进程同样拒绝，且给出可读原因）。
   */
  probeIllegalCall = (): Promise<BridgeReply<unknown>> =>
    this.dispatch({ id: 'shell.thisCapabilityDoesNotExist', args: [] } as unknown as BridgeRequest);

  /**
   * 插件树快照（spec 1.3-01 / 1.3-09 / 1.3-10 的界面证据）。
   * 内核缺席时返回空树并说明原因，而不是让渲染层拿到一个异常。
   */
  getPluginTree = (): { nodes: PluginNodeView[]; manifestError?: string } => {
    const kernel = this.ctx.get('kernel') as KernelReader | undefined;
    if (!kernel) return { nodes: [], manifestError: '内核未挂载（cordis.yml 里没有 kernel 实现或被禁用）' };
    return { nodes: kernel.snapshot(), manifestError: kernel.manifestError };
  };

  /** 最近 N 条已脱敏日志 + 落盘路径（spec 1.3-04 / 1.3-05 / 1.3-11 的界面证据）。 */
  getLogTail = (limit = 50): { lines: LogLineView[]; file?: string; level: string } => {
    const log = this.ctx.get('log') as LogReader | undefined;
    if (!log) return { lines: [], level: 'none' };
    return { lines: log.tail(limit), file: log.filePath, level: log.level };
  };

  /**
   * 仅开发态可用：写一条带敏感字段的日志，然后立刻回读，
   * 用来在界面上验收 1.3-11（出口脱敏对结构化字段与自由文本都生效）。
   */
  probeRedact = (): { lines: LogLineView[] } => {
    if (app.isPackaged) throw new Error('probeRedact 只在开发态开放');
    this.ctx.logger.warn('登录失败 token=abc123 状态 500', {
      authorization: 'Bearer x.y.z',
      phone: '13800001111',
      email: 'zhangsan@qq.com',
    });
    return { lines: this.getLogTail(5).lines };
  };

  /** 把一次桥接请求路由到本服务的实例方法；白名单外一律拒绝。 */
  private dispatch = async (request: BridgeRequest): Promise<BridgeReply<unknown>> => {
    if (!request || typeof request.id !== 'string') {
      return { ok: false, error: '调用载荷不合法：缺少 id' };
    }
    if (!isAllowedCall(request.id)) {
      return { ok: false, error: `能力未在白名单中：${String(request.id)}` };
    }
    const [, method] = request.id.split('.');
    const methods = this as unknown as Record<string, ((...args: unknown[]) => unknown) | undefined>;
    const handler = methods[method ?? ''];
    if (typeof handler !== 'function') {
      return { ok: false, error: `白名单指向的方法不存在：${request.id}` };
    }
    return { ok: true, value: await handler(...(request.args ?? [])) };
  };

  /** 注册 `cordis:call` 入站处理：白名单外一律拒绝，异常转成可读回复而不是崩溃。 */
  private registerBridge() {
    ipcMain.handle(IPC_CHANNELS.call, (_event, request: BridgeRequest) =>
      this.dispatch(request).catch((error: unknown) => {
        this.noteError(error);
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }),
    );
  }

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
      },
    });
    this.mainWindow = win;

    this.kernelView = new WebContentsView();
    win.contentView.addChildView(this.kernelView);
    this.kernelView.setVisible(this.kernelViewVisible);
    // 新建的 view 默认尺寸是 0x0：不显式摆位就永远看不见，只有 resize 才会救回来。
    this.layoutKernelView();
    void this.kernelView.webContents.loadURL(kernelViewPlaceholder);

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
    else void win.loadFile(path.join(repoRoot, 'packages', 'renderer', 'dist', 'index.html'));
  }

  /** 按固定比例给内核视图摆位，与渲染层槽位共用 `KERNEL_VIEW_WIDTH_RATIO`。 */
  private layoutKernelView = () => {
    const win = this.mainWindow;
    if (!win || !this.kernelView) return;
    const { width, height } = win.getContentBounds();
    const viewWidth = Math.round(width * KERNEL_VIEW_WIDTH_RATIO);
    this.kernelView.setBounds({ x: width - viewWidth, y: 0, width: viewWidth, height });
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
  }
}
