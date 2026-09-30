/**
 * `browser.act` 服务（spec 2.2-03 / 2.2-10 / 2.2-12 / 2.2-13）：把「一次页面动作」做完。
 *
 * 顺序是写死的：**先等到可点，再定位，再动手**。反过来（先点再等）在真实站点上就是
 * 「点了个空」——页面把按钮往下推 20px，坐标已经作废，所以几何稳定也必须算等待条件。
 *
 * 两条通道如实报告（spec 2.2-12）：
 * - `cdp`：`webContents.debugger` 派发真实输入事件，页面读到的 `isTrusted` 为 true；
 * - `dom`：帧内脚本直接操作元素，`isTrusted` 为 false。退回这条只在「attach 不上」或
 *   「iframe 偏移认不出」时发生，且**永远不猜坐标**——猜出来的点位置会把动作打到别人身上。
 * `<select>` 的原生下拉没有可信输入可模拟（要点开系统弹层），所以它固定走 DOM 通道。
 */
import { AppError, asApp, Service, type Context } from '@auto-cc/core';
import type { ActResultView, LocatedView, LocateSpec, WaitPredicate } from '@auto-cc/shared';
import type { WebContents } from 'electron';
import { z } from 'zod';
import {
  evaluateInFrames,
  findFrameByUrl,
  readingsFromFrames,
  requireKernelContents,
  type KernelHost,
} from './frame-channel.js';
import { dispatchClick, dispatchType, viewportPointOf } from './input-channel.js';
import {
  DEFAULT_SCRIPT_LIMITS,
  buildDomActionScript,
  buildValueReadScript,
  buildWaitScript,
  toDomActionReading,
  toWaitReading,
} from './locator-script.js';
import type { BrowserLocateService } from './locate-service.js';
import type { BrowserPageService } from './index.js';

export const browserActSchema = z.strictObject({
  /** 一次动作前的等待上限（毫秒）；超时即结构化失败，不静默继续（spec 2.2-04）。 */
  waitForTimeoutMs: z.number().int().min(200).max(30_000).default(5000),
  /** 「可点击」谓词要求连续几帧几何一致，避免点到正在被布局往下推的元素（spec 2.2-03）。 */
  stableCheckSamples: z.number().int().min(1).max(5).default(2),
  /** 观察器之外的兜底轮询间隔（毫秒）：样式与滚动变化不产生 mutation，只靠观察器等不到。 */
  waitCheckMs: z.number().int().min(16).max(2_000).default(100),
  /** 关掉即显式降级到 DOM 通道（结果里 `channel` 与 `trusted` 会如实变成 dom / false）。 */
  cdpInputEnabled: z.boolean().default(true),
});

/** 校验后的配置形状（调用点与测试引用它，而不是手写一遍 zod 推断）。 */
export type BrowserActConfig = z.output<typeof browserActSchema>;

/** 一次动作在页面里的结局：走哪条通道、事件是否受信、回读到什么值。 */
type ActionOutcome = { channel: 'cdp' | 'dom'; trusted: boolean; valueAfter: string | null };

/**
 * 取一条候选的跨调用身份（候选下标 + 帧内身份号）。
 * @param chosen 胜出候选
 * @returns DOM 通道找回同一节点所需的两个键
 */
function identityOf(chosen: LocatedView): { candidateIndex: number; nodeIndex: number } {
  return { candidateIndex: chosen.candidateIndex, nodeIndex: chosen.nodeIndex };
}

export class BrowserActService extends Service {
  static provide = 'browser.act';
  static Config = browserActSchema;
  /** 动作必经定位：同一份打分与阈值只此一处（AGENTS.md §2.5）。 */
  /** `browser.page` 也必须声明：等不到可点时那条结构化失败要带快照，漏了就会以 TypeError 顶掉 WAIT_TIMEOUT。 */
  static inject = ['shell', 'browser.locate', 'browser.page'];

  constructor(
    ctx: Context,
    private readonly config: BrowserActConfig,
  ) {
    super(ctx, 'browser.act');
  }

  /**
   * 点击声明指向的元素。
   * @param spec 定位声明
   * @returns 动作结局；`channel` 与 `trusted` 说明事件是怎么产生的
   * @throws 等不到可点 `WAIT_TIMEOUT`、定位未过线 `LOCATE_FAILED`、动作被页面拒绝 `ACT_FAILED`（三者都带 spec 与快照引用）
   */
  click = async (spec: LocateSpec): Promise<ActResultView> => this.perform('click', spec);

  /**
   * 往声明指向的输入控件里写文本（中文与 emoji 原样送入，spec 2.2-13）。
   * @param spec 定位声明
   * @param text 待输入文本，可含中文、emoji 与空白
   * @returns 动作结局，`valueAfter` 是页面里回读到的当前值（不是发出去的那个串）
   * @throws 与 `click` 同一组结构化错误
   */
  type = async (spec: LocateSpec, text: string): Promise<ActResultView> => this.perform('type', spec, text);

  /**
   * 选中下拉里的一个值。
   * @param spec 定位声明（指向 `select` 元素）
   * @param value 目标选项值
   * @returns 动作结局；`channel` 恒为 `dom`（原生弹层没有可信输入可模拟，如实标注而不是假装受信）
   * @throws 与 `click` 同一组结构化错误
   */
  select = async (spec: LocateSpec, value: string): Promise<ActResultView> => this.perform('select', spec, value);

  /**
   * 只等不动手（spec 2.2-03 的五类谓词）。
   * @param predicate 谓词声明；`spec` 是要等的元素
   * @returns `status` 为 `done` 表示等到、`timeout` 表示没等到——超时在这条路径上是结局，不是异常
   * @throws 没有已挂载会话 `NO_KERNEL_SESSION`；所有帧读取失败 `PAGE_SCRIPT_FAILED`
   */
  waitFor = async (predicate: WaitPredicate): Promise<ActResultView> => {
    const startedAt = Date.now();
    const satisfied = await this.waitSatisfied(predicate.spec, predicate.kind);
    return {
      action: 'wait',
      status: satisfied ? 'done' : 'timeout',
      waitedMs: Date.now() - startedAt,
      // 等待不产生任何页面事件：读数只来自脚本观察，所以 trusted 恒为 false，不冒充 CDP。
      channel: 'dom',
      trusted: false,
      located: null,
      valueAfter: null,
      predicate: { kind: predicate.kind, satisfied },
    };
  };

  /**
   * 动作的公共骨架：等待 → 定位 → 折算坐标 → 下发 → 回读。
   * @param action 动作类型
   * @param spec 定位声明
   * @param payload 输入文本或选项值（点击为 undefined）
   * @returns 界面与适配器共用的动作读数
   */
  private async perform(
    action: 'click' | 'type' | 'select',
    spec: LocateSpec,
    payload?: string,
  ): Promise<ActResultView> {
    const contents = requireKernelContents(this.host, 'browser.act');
    const startedAt = Date.now();
    if (!(await this.waitSatisfied(spec, 'clickable'))) {
      throw await this.waitTimeout(spec, Date.now() - startedAt, contents);
    }
    const result = await this.locate.find(spec);
    if (!result.chosen) {
      throw new AppError('LOCATE_FAILED', `定位未过线，动作没有执行：${result.reason}`, 'browser.act', {
        spec,
        status: result.status,
        snapshotRef: result.snapshotRef,
        snapshot: result.snapshot,
      });
    }
    const point = await this.viewportPoint(contents, result.chosen);
    const outcome = await this.dispatch(action, spec, result.chosen, payload, point, contents);
    return {
      action,
      status: 'done',
      waitedMs: Date.now() - startedAt,
      channel: outcome.channel,
      trusted: outcome.trusted,
      located: result.chosen,
      valueAfter: outcome.valueAfter,
      predicate: null,
    };
  }

  /**
   * 在整棵帧树里跑等待脚本，任一帧满足即算满足。
   * @param spec 被等待元素的声明
   * @param kind 谓词类型
   * @returns 是否满足（聊天框在子帧里满足就够了，spec 2.2-10）
   */
  private async waitSatisfied(spec: LocateSpec, kind: WaitPredicate['kind']): Promise<boolean> {
    const contents = requireKernelContents(this.host, 'browser.act');
    const source = buildWaitScript(
      kind,
      spec.candidates,
      this.config.waitForTimeoutMs,
      this.config.waitCheckMs,
      DEFAULT_SCRIPT_LIMITS,
      this.config.stableCheckSamples,
    );
    const readings = readingsFromFrames(await evaluateInFrames(contents, source, true), (raw) => [toWaitReading(raw)]);
    return readings.some((reading) => reading.satisfied);
  }

  /**
   * 把帧内矩形折算成视图坐标。
   * @param contents 内核视图句柄
   * @param chosen 胜出候选
   * @returns 视图坐标点，以及「每一层 iframe 是否都认出来了」
   */
  private async viewportPoint(
    contents: WebContents,
    chosen: LocatedView,
  ): Promise<{ point: { x: number; y: number }; resolved: boolean }> {
    const frame = findFrameByUrl(contents, chosen.frameUrl);
    if (!frame) {
      // 页面已经跳转：宁可不点，也不按过期坐标点一下别的东西。
      return { point: { x: 0, y: 0 }, resolved: false };
    }
    return viewportPointOf(frame, chosen.rect);
  }

  /**
   * 下发一次动作，必要时退回 DOM 通道。
   * @param action 动作类型
   * @param spec 定位声明
   * @param chosen 胜出候选
   * @param payload 输入文本或选项值
   * @param point 视图坐标与折算结论
   * @param contents 内核视图句柄
   * @returns 通道、是否受信、页面回读到的值
   */
  private async dispatch(
    action: 'click' | 'type' | 'select',
    spec: LocateSpec,
    chosen: LocatedView,
    payload: string | undefined,
    point: { point: { x: number; y: number }; resolved: boolean },
    contents: WebContents,
  ): Promise<ActionOutcome> {
    const useCdp = this.config.cdpInputEnabled && action !== 'select' && point.resolved;
    if (useCdp) {
      const sent =
        action === 'click'
          ? await dispatchClick(contents, point.point)
          : await dispatchType(contents, point.point, payload ?? '');
      if (sent) {
        return {
          channel: 'cdp',
          trusted: true,
          // 输入类动作一律回读页面里的真值：发出去的串不等于页面收到了什么（spec 2.2-13）。
          valueAfter: action === 'click' ? null : await this.readValue(spec, chosen),
        };
      }
      this.ctx.logger.warn(`CDP 输入通道不可用，本次 ${action} 退回 DOM 通道（事件不受信）`);
    }
    const reading = await this.domAction(action, spec, chosen, payload);
    if (!reading.ok) {
      throw new AppError('ACT_FAILED', `页面动作失败：${reading.error}`, 'browser.act', {
        spec,
        action,
        snapshotRef: `${contents.getURL()}@${String(Date.now())}`,
      });
    }
    return { channel: 'dom', trusted: false, valueAfter: action === 'click' ? null : reading.valueAfter };
  }

  /**
   * 走帧内脚本执行动作（`isTrusted:false`，只作为显式降级）。
   * @param action 动作类型
   * @param spec 定位声明
   * @param chosen 胜出候选
   * @param payload 输入文本或选项值
   * @returns 页面里的动作读数
   */
  private async domAction(
    action: 'click' | 'type' | 'select',
    spec: LocateSpec,
    chosen: LocatedView,
    payload?: string,
  ): Promise<{ ok: boolean; valueAfter: string; error: string }> {
    const source = buildDomActionScript(action, spec.candidates, identityOf(chosen), payload, DEFAULT_SCRIPT_LIMITS);
    return toDomActionReading(await this.frameOf(chosen).executeJavaScript(source, true));
  }

  /**
   * 回读目标控件的当前值。
   * @param spec 定位声明
   * @param chosen 胜出候选
   * @returns 页面里的值；节点已经不在就当空串（不让一次回读把整次动作打崩）
   */
  private async readValue(spec: LocateSpec, chosen: LocatedView): Promise<string> {
    const source = buildValueReadScript(spec.candidates, identityOf(chosen), DEFAULT_SCRIPT_LIMITS);
    return toDomActionReading(await this.frameOf(chosen).executeJavaScript(source, true)).valueAfter;
  }

  /**
   * 读数所在的那一帧（跳转后按地址找不回时退回主帧，让脚本报「节点不在了」而不是静默成功）。
   * @param chosen 胜出候选
   * @returns 可直接求值的帧对象
   */
  private frameOf(chosen: LocatedView) {
    const contents = requireKernelContents(this.host, 'browser.act');
    return findFrameByUrl(contents, chosen.frameUrl) ?? contents.mainFrame;
  }

  /**
   * 拼等不到的结构化失败（spec 2.2-04 要的是「有现场可看」，不是只有一句超时）。
   * @param spec 动作声明
   * @param waitedMs 实际等了多久（毫秒）
   * @param contents 内核视图句柄，用于拼快照引用
   * @returns 带 spec、快照引用与最后一次 DOM 快照的结构化错误
   */
  private async waitTimeout(spec: LocateSpec, waitedMs: number, contents: WebContents): Promise<AppError> {
    const at = Date.now();
    return new AppError(
      'WAIT_TIMEOUT',
      `等待可点击超时（${String(this.config.waitForTimeoutMs)}ms 内未满足）`,
      'browser.act',
      {
        spec,
        waitedMs,
        snapshotRef: `${contents.getURL()}@${String(at)}`,
        snapshot: await this.page.snapshot().catch(() => null),
      },
    );
  }

  /** 壳层的视图宿主句柄。 */
  private get host(): KernelHost {
    return asApp(this.ctx).shell;
  }

  /** 定位服务的读取面（动作先定位再下发，判定口径不在此重复）。 */
  private get locate(): Pick<BrowserLocateService, 'find'> {
    return asApp(this.ctx)['browser.locate'];
  }

  /** 页面服务的快照面（失败现场的唯一来源）。 */
  private get page(): Pick<BrowserPageService, 'snapshot'> {
    return asApp(this.ctx)['browser.page'];
  }

  [Service.init](): void {
    this.ctx.logger.info(
      `动作服务就绪：等待上限 ${String(this.config.waitForTimeoutMs)}ms · 稳定采样 ${String(
        this.config.stableCheckSamples,
      )} 帧 · CDP 输入 ${this.config.cdpInputEnabled ? '开' : '关（退回 DOM，事件不受信）'}`,
    );
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'browser.act': BrowserActService;
  }
}
