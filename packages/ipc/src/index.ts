/**
 * `ipc` 服务（spec 1.4）：全应用唯一的 IPC 网关。
 *
 * 三件事都在这里，别处不许再碰：
 *
 * 1. 入站：`cordis:call` 的处理器只注册这一处，按 `@auto-cc/shared` 的白名单校验后
 *    把 `service.method` 解析到 cordis 服务实例上（`Gateway` 承担纯逻辑，可单测）。
 * 2. 出站：`RENDERER_EVENTS` 里登记过的事件从 ctx 转发到 `cordis:event`。
 *    目标是 `BrowserWindow`，不含内嵌内核视图（`WebContentsView`）——招聘站页面拿不到 app 的事件流。
 * 3. 生命周期：卸载时摘掉处理器与监听，restart 后重新注册，不会撞「重复注册」。
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import { AppError, Service, type Context, type LogLineView } from '@auto-cc/core';
import {
  IPC_CHANNELS,
  RENDERER_ALLOWLIST,
  RENDERER_EVENTS,
  type BridgeRequest,
  type IpcStatsView,
  type RendererEvent,
} from '@auto-cc/shared';
import { z } from 'zod';
import { Gateway } from './gateway.js';

/** 网关暂无可选项；strict 让 cordis.yml 里写错的键在挂载期就报错。 */
export const ipcSchema = z.strictObject({});

/** 校验后的配置形状（调用点与测试引用它，而不是手写一遍 zod 推断）。 */
export type IpcConfig = z.infer<typeof ipcSchema>;

export class IpcGatewayService extends Service {
  static provide = 'ipc';
  static Config = ipcSchema;

  private readonly gateway: Gateway;
  /** 已登记事件的退订函数，卸载时逐个调用。 */
  private unbind: Array<() => void> = [];

  constructor(ctx: Context, _options: IpcConfig) {
    super(ctx, 'ipc');
    // 网关无配置项，但必须接住第二个实参：cordis 挂载时传的是校验后的配置对象，
    // 只声明一个参数会让带配置的调用点在类型检查时报 TS2345。
    this.gateway = new Gateway({
      lookup: (name) => this.lookupService(name),
      onDenied: (path, error) => this.ctx.logger.warn(`拒绝调用 ${path}：${error.code} ${error.message}`),
    });
    // 通道注册放在构造期：窗口由后装的 shell 创建（shell 声明 inject:['ipc']），
    // 因此渲染层能发起调用时处理器一定已经在位，不会撞「No handler registered」。
    ipcMain.handle(IPC_CHANNELS.call, (_event, request: BridgeRequest) => this.gateway.invoke(request));
  }

  /**
   * 入站统计（在途 / 已完成 / 白名单拒绝），渲染层面板与 harness 读它（spec 1.4-06 / 1.6-12）。
   *
   * 刻意是**方法**而不是 getter：网关只允许调用可调用成员（`pickMethod`），
   * 属性读数会被判定成 `METHOD_NOT_FOUND`——那是设计上的收紧，不是遗漏。
   */
  stats = (): IpcStatsView => this.gateway.stats;

  /**
   * 仅开发态可用：按给定 path 走一遍网关，把网关的拒绝**原样抛出**。
   *
   * 白名单外的能力在渲染层根本不存在（preload 不生成它），所以「主进程同样拒绝」这一条
   * 只能由主进程自己演示一次，这就是本方法的全部用途（spec 1.4-04 / 1.4-07）。
   *
   * 这里必须抛错而不是把 `gateway.invoke` 的返回值直接返回：那样会套出
   * `{ok:true, value:{ok:false, error}}` 两层同名信封，界面上读到的是外层，
   * 「白名单放行了」和「网关拒了」就分不开。抛出去之后跨进程的仍是唯一一层信封。
   */
  probeReject = async (path: string): Promise<unknown> => {
    if (app.isPackaged) throw new Error('probeReject 只在开发态开放');
    const reply = await this.gateway.invoke({ path, args: [] });
    if (reply.ok) return reply.value;
    throw new AppError(reply.error.code, reply.error.message, reply.error.path, reply.error.details);
  };

  /** 服务名 → 实例；cordis 对未注册的名可能抛错，一律收成 undefined 交给解析层判断。 */
  private lookupService(name: string): object | undefined {
    try {
      return this.ctx.get(name) as object | undefined;
    } catch {
      return undefined;
    }
  }

  /** 把事件推给所有主窗口。内嵌内核视图（`WebContentsView`）不在目标里，招聘站页面拿不到 app 事件流。 */
  private push(event: RendererEvent): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.event, event);
    }
  }

  [Service.init](): void {
    // 只订阅 `RENDERER_EVENTS` 登记过的事件：没登记的名字在这里根本不会被接上，
    // 因此「未登记事件不出进程」是结构上成立的，而不是靠运行期过滤。
    for (const name of RENDERER_EVENTS) {
      const off = this.ctx.on(name, (line: LogLineView) => this.push({ event: name, payload: line }));
      this.unbind.push(off);
    }
    // 单层箭头会在挂载瞬间就被回收，所以 effect 必须「返回函数」。
    this.ctx.effect(
      () => () => {
        ipcMain.removeHandler(IPC_CHANNELS.call);
        for (const off of this.unbind.splice(0)) off();
      },
      'ipc.gateway',
    );
    this.ctx.logger.info(
      `IPC 网关就绪：${IPC_CHANNELS.call} / ${IPC_CHANNELS.event}（能力 ${RENDERER_ALLOWLIST.length} 项，事件 ${RENDERER_EVENTS.length} 项）`,
    );
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    ipc: IpcGatewayService;
  }
}

export { Gateway, type GatewayDeps } from './gateway.js';
export { pathCandidates, pickMethod, resolveCall, type Resolution } from './resolve.js';
