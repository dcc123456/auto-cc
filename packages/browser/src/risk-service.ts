/**
 * `browser.risk` 服务（spec 2.7-01）：主文档响应的**风控信号观测**。
 *
 * 它只做一件事——把「这个页面看起来被风控拦下来了」变成一条 `browser/risk-signal` 事件，
 * 别的什么都不做：**不停工作流、不重试、不识别验证码**。暂停由 `workflow.runner` 订阅事件后
 * 走它已有的那条 `stop()` 路径（与 `session/expired` 一模一样），识别与规避则是 AGENTS.md §8.3
 * 明令禁止的能力。观测侧同样不改写请求：`onResponseStarted` 的 listener 没有 callback，
 * 看一眼不会让请求停下来，也不会绕过任何一次校验。
 *
 * 两类判据分成两条来源，是因为它们的归属不同：
 * - **HTTP 状态码**（403 / 429 一类）是产品口径，装在配置里（`riskStatusCodes`），换口径改配置；
 * - **页面文案**（「安全验证」「访问受限」）是站点知识，装在知识包的 `risk` 段里，
 *   经 `platform.registry.riskPatternOf` 现问现取——本包不认识 BOSS，也不该认识（plan §3 规则 1）。
 *
 * 一条必须记住的实测（plan §14.2 H）：**同一个 session 的同一个 webRequest 事件只有一个 handler**，
 * 第二次注册直接覆盖第一个。所以这个服务是那唯一槽位的**独占者**：挂载幂等（重复挂载就是替换），
 * 卸载时必须归还（`ctx.effect` 里接住 `sessions` 交回来的摘除函数）。
 */
import { asApp, Service, type Context } from '@auto-cc/core';
import { partitionFor, type KernelPageSnapshotView, type RiskSignalEvent } from '@auto-cc/shared';
import type { MainFrameResponseReading, SessionsService } from '@auto-cc/plugin-sessions';
import type { WebContents } from 'electron';
import { z } from 'zod';
import { requireKernelContents, settleLoad, type KernelHost } from './frame-channel.js';
import type { BrowserPageService } from './index.js';
import type { PlatformRegistryService } from './platform-registry.js';

export const browserRiskSchema = z.strictObject({
  /**
   * 判为风控的主文档响应状态码。
   *
   * 为什么不是固定写死：403 在有些站点是「这个岗位不给看」，429 在有些站点是「你太快了」，
   * 而「哪种算拦停下来」是会随真实站点校准变化的产品口径——口径进配置，代码只负责命中就发信号。
   */
  riskStatusCodes: z.array(z.number().int().min(100).max(599)).min(1).default([403, 429]),
  /** 等页面正文可读的上限（毫秒）；超时不判失败，仍然读一次——403 页面也是先有响应后有正文。 */
  pageSettleTimeoutMs: z.number().int().min(500).max(30_000).default(10_000),
});

/** 校验后的配置形状（调用点与测试引用它，而不是手写一遍 zod 推断）。 */
export type BrowserRiskConfig = z.output<typeof browserRiskSchema>;

/**
 * 在一趟响应的可见文字里找风控文案。
 *
 * 三处都找，是因为站点把那句话放在哪儿并不统一：反代拦下来时它在状态行（「Forbidden」），
 * 前端自己做验证页时它在标题（「安全验证 - BOSS 直聘」），而「访问受限，请稍后再试」常在正文里。
 * @param statusLine 响应的状态行原文（如 `HTTP/1.1 403 Forbidden`）
 * @param snapshot 已经读到的页面快照
 * @param pattern 编译好的文案判据
 * @returns 命中的那段原文（进事件详情，够界面说清「撞上了哪句话」）；没命中为 null
 */
export function matchRiskText(statusLine: string, snapshot: KernelPageSnapshotView, pattern: RegExp): string | null {
  const match = pattern.exec(`${statusLine}\n${snapshot.title}\n${snapshot.bodyText}`);
  return match ? match[0] : null;
}

export class BrowserRiskService extends Service {
  static provide = 'browser.risk';
  static Config = browserRiskSchema;
  /** 观测口来自 `sessions`（分区归属），正文来自 `browser.page`，判据来自 `platform.registry`。 */
  static inject = ['shell', 'sessions', 'browser.page', 'platform.registry'];

  /** 编译过的文案判据缓存：知识包不变就不该每次响应都重新编译一遍正则。 */
  private readonly compiled = new Map<string, RegExp>();

  constructor(
    ctx: Context,
    private readonly config: BrowserRiskConfig,
  ) {
    super(ctx, 'browser.risk');
  }

  async [Service.init](): Promise<void> {
    // 观测口的生命周期跟着本服务走：卸载时归还摘除函数，槽位空出来（独占者退出，不留一个哑 handler）。
    // 这里的 await 不是可有可无：`sessions` 那一侧要等 `app.whenReady()` 才拿得到分区会话（见其文档），
    // 不等就是本服务在挂载期抛错、整条风控观测线装不上（2.7-c 运行期实测）。
    const off = await this.sessions.observeMainFrameResponses(this.handleResponse);
    this.ctx.effect(() => off, 'browser.risk.observer');
    this.ctx.logger.info(
      `风控观测就绪：状态码 ${this.config.riskStatusCodes.join(' / ')} · 正文等待上限 ${String(
        this.config.pageSettleTimeoutMs,
      )}ms`,
    );
  }

  /**
   * 一条主框架响应的处置入口（同步交出，判定在异步里做——观测 listener 不能阻塞内核）。
   * @param reading 响应读数
   */
  private handleResponse = (reading: MainFrameResponseReading): void => {
    void this.inspect(reading);
  };

  /**
   * 判定这一趟响应是不是被风控拦下，命中就发一条信号。
   * @param reading 主框架响应读数
   * @returns 无返回值：命中与否都只体现在事件与日志上，观测层没有「失败」可报（报错也没人接）
   */
  private async inspect(reading: MainFrameResponseReading): Promise<void> {
    if (this.config.riskStatusCodes.includes(reading.statusCode)) {
      // 一趟导航只发一条信号：状态码已经足够定性，再读一次页面只会把同一件事说两遍。
      this.emitSignal(reading, 'http-status', `HTTP ${String(reading.statusCode)}`, reading.url);
      return;
    }
    const source = this.registry.riskPatternOf(reading.platform);
    if (!source) return;
    const view = this.currentViewFor(reading.platform);
    if (!view) return;
    const outcome = await settleLoad(view, this.config.pageSettleTimeoutMs);
    let snapshot: KernelPageSnapshotView;
    try {
      snapshot = await this.page.snapshot();
    } catch (error) {
      // 读不到正文时绝不判「没风控」——那一趟装载的结局在这里留一句，界面与日志才解释得清为什么没停。
      this.ctx.logger.warn(
        `风控正文判据读取失败（${reading.platform} · 装载 ${outcome}）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    const hit = matchRiskText(reading.statusLine, snapshot, this.regexFor(source));
    if (hit) this.emitSignal(reading, 'page-text', hit, reading.url);
  }

  /**
   * 取当前视图句柄，但只在「这个视图确实装着这个平台」时取。
   *
   * 为什么要有这一层核对：观测 listener 是挂在**分区**上的（视图销毁也还在），而正文只能从
   * 当前那一块视图读。用户已经把视图切去别的平台时，读回来的正文属于别人，
   * 拿它判风控就是拿别的站点的文案给这个平台定罪。
   * @param platform 响应读数里的平台标识（按分区归属给的，不是从地址猜的）
   * @returns 可以读正文的视图；没有视图或视图属于别的平台时为 null（这条只做「这一趟不读正文」）
   */
  private currentViewFor(platform: string): WebContents | null {
    if (this.host.getStatus().kernelViewPartition !== partitionFor(platform)) return null;
    try {
      const contents = requireKernelContents(this.host, 'browser.risk');
      return contents.isDestroyed() ? null : contents;
    } catch {
      return null;
    }
  }

  /**
   * 按判据源码取编译好的正则（同一份知识包只编译一次）。
   * @param source 知识包 `risk.riskPattern` 里的正则源码
   * @returns 可复用的 RegExp；`parseKnowledgePack` 已在加载时验证过它能编译
   */
  private regexFor(source: string): RegExp {
    const cached = this.compiled.get(source);
    if (cached) return cached;
    const compiled = new RegExp(source, 'i');
    this.compiled.set(source, compiled);
    return compiled;
  }

  /**
   * 发出一条风控信号（本服务唯一的对外出口）。
   * @param reading 触发判定的响应读数（提供平台标识与地址）
   * @param kind 判据类别：状态码命中 / 页面文案命中
   * @param detail 命中详情——只有状态码或命中的那段文案，绝不带页面正文节选与 cookie（AGENTS.md §8.5）
   * @param url 被拦下的那个地址
   */
  private emitSignal(
    reading: MainFrameResponseReading,
    kind: RiskSignalEvent['kind'],
    detail: string,
    url: string,
  ): void {
    const event: RiskSignalEvent = {
      platform: reading.platform,
      kind,
      detail,
      url,
      at: Date.now(),
    };
    this.ctx.logger.warn(`风控信号：${reading.platform} 的 ${url}（${kind}：${detail}）`);
    this.ctx.emit('browser/risk-signal', event);
  }

  /** 会话侧的观测口（只读主文档响应，判定口径不在那边）。 */
  private get sessions(): Pick<SessionsService, 'observeMainFrameResponses'> {
    return asApp(this.ctx).sessions;
  }

  /** 壳层视图宿主（只用来确认「当前那块视图属于这个平台」）。 */
  private get host(): KernelHost {
    return asApp(this.ctx).shell;
  }

  /** 页面服务的快照面（正文的唯一来源，读取脚本不在这里复制第二份）。 */
  private get page(): Pick<BrowserPageService, 'snapshot'> {
    return asApp(this.ctx)['browser.page'];
  }

  /** 登记处的风控判据面。 */
  private get registry(): Pick<PlatformRegistryService, 'riskPatternOf'> {
    return asApp(this.ctx)['platform.registry'];
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'browser.risk': BrowserRiskService;
  }
}
