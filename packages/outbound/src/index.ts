/**
 * `outbound.sample` 服务（spec 1.9-05 / 1.9-06）：闸门**之外**的最薄业务消费者。
 *
 * 它存在的理由只有一个：证明「外发必经闸门」是结构事实，而不是文档约定。
 * 所以它住在另一个包里 —— 如果外发样例就写在闸门包内部，1.9-06 那条 grep
 * （业务层不含付费分支）就变成在闸门自己的代码里找闸门，断言是空的（plan §8.4）。
 *
 * 全文没有一处 `if (额度)` / `if (付费)`：它只把闭包交给 `gate.perform()`，
 * 被拒时拿到的是 `QUOTA_EXCEEDED` 结构化错误，原样上浮给界面（AGENTS.md §7.3）。
 */
import { AppError, asApp, Service, type Context } from '@auto-cc/core';
import { OUTBOUND_SAMPLE_ACTIONS, type SendReceiptView, type SendSampleRequest } from '@auto-cc/shared';
import { z } from 'zod';

/**
 * 入站参数校验（渲染层是不可信来源，AGENTS.md §2.6「边界校验只在系统边界做」）。
 *
 * `action` 从任意非空字符串收窄成枚举（spec 2.7-03 / plan §14.4 第 4 条）：日上限改成按动作取值之后，
 * 任意字符串就等于让渲染层**发明新的免限动作名**——传一个 `dailyLimits` 里没有的名字，
 * 闸门要么不认识（报错）要么得为未知动作现编一条兜底，两条都是把额度绕成摆设。
 * 这里连 `search` 都不收：抓取那一条账由 `jd.capture` 跑完一轮后自己经闸门落，界面没有「发一次搜索」。
 */
const sendRequestSchema = z.strictObject({
  action: z.enum(OUTBOUND_SAMPLE_ACTIONS),
  targetId: z.string().min(1),
  message: z.string().min(1),
  workflowRunId: z.string().min(1).nullish(),
});

export const outboundSchema = z.strictObject({
  /** 收件端点：P1 只允许本地 fixture（AGENTS.md §7.2 测试不碰真实平台）。 */
  endpoint: z.url().default('http://127.0.0.1:10233/api/outbound'),
});

/** 校验后的配置形状（调用点与测试引用它，而不是手写一遍 zod 推断）。 */
export type OutboundConfig = z.infer<typeof outboundSchema>;

export class OutboundSampleService extends Service {
  static provide = 'outbound.sample';
  static Config = outboundSchema;
  // 依赖闸门服务名（不是清单 id）：闸门被摘掉后本服务进 PENDING，外发入口在网关侧就解析不出来。
  static inject = ['entitlement.gate'];

  private readonly options: OutboundConfig;

  constructor(ctx: Context, options: OutboundConfig) {
    // 必须接住第二个实参：cordis 递的是校验后的配置（AGENTS.md §9 实测 1.3）。
    super(ctx, 'outbound.sample');
    this.options = options;
  }

  /**
   * 发一条样例消息 —— 唯一入口是 `gate.perform()`。
   * @param request 动作名、目标 id、正文，以及可选的工作流运行 id（P1 多为 null）
   * @returns 回执（含账本行 id 与对端累计收件数）；额度不足时以 `QUOTA_EXCEEDED` 失败，不静默跳过
   */
  send = async (request: SendSampleRequest): Promise<SendReceiptView> => {
    const parsed = sendRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `外发请求不合法：${parsed.error.issues[0]?.message ?? ''}`,
        'outbound.sample',
      );
    }
    const gate = asApp(this.ctx)['entitlement.gate'];
    const { value, ledgerId } = await gate.perform(
      parsed.data.action,
      { targetId: parsed.data.targetId, workflowRunId: parsed.data.workflowRunId ?? null },
      () => this.deliver(parsed.data.action, parsed.data.targetId, parsed.data.message),
    );
    this.ctx.logger.info(`样例外发已完成：动作 ${parsed.data.action} · 对端累计 ${String(value)} 条`);
    return {
      action: parsed.data.action,
      targetId: parsed.data.targetId,
      ledgerId,
      delivered: value,
    };
  };

  /**
   * 真正的传输：把消息 POST 给本地 fixture，换回它累计收到的条数。
   *
   * 只有这一层会在 P2 被换成内核视图（plan §8.4 决策 7）；
   * 「由对端计数」是这条验收的证据来源 —— app 自述发出去了不算。
   * @param action 动作名（进消息体，供对端与证据文件对齐）
   * @param targetId 目标 id
   * @param message 正文
   * @returns fixture 侧累计收到的条数
   * @throws 连不上或对端非 2xx 时以 `OUTBOUND_FAILED` 失败（detail 带端点），不落账
   */
  private deliver = async (action: string, targetId: string, message: string): Promise<number> => {
    let response: Response;
    try {
      response = await fetch(this.options.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, targetId, message, ts: Date.now() }),
      });
    } catch (cause) {
      // 连不上时对端不会有响应，`fetch` 是直接 reject 的；不转成就结构化错误，界面上只剩 "fetch failed"。
      throw new AppError(
        'OUTBOUND_FAILED',
        `对端不可达：${cause instanceof Error ? cause.message : String(cause)}`,
        'outbound.sample',
        { endpoint: this.options.endpoint },
      );
    }
    if (!response.ok) {
      throw new AppError('OUTBOUND_FAILED', `对端返回 ${String(response.status)}`, 'outbound.sample', {
        endpoint: this.options.endpoint,
      });
    }
    const body = (await response.json()) as { received?: number };
    return Number(body.received ?? 0);
  };

  [Service.init](): void {
    this.ctx.logger.info(`外发样例就绪：收件端点 ${this.options.endpoint}`);
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'outbound.sample': OutboundSampleService;
  }
}

// 话术生成是同一个域（"要发出去的内容从哪来"）的第二个服务，所以同包不同 provider 名。
export * from './script.js';
// 频控间隔是第三个：它是外发的性质不是平台的性质（plan §12.3），所以不放适配器里。
export * from './throttle.js';
// 打招呼编排是第四个：把上面三个加上闸门串成唯一的外发入口（plan §12.3 的「发送编排」那一行）。
export * from './greet.js';
// 投递编排是第五个：与打招呼共用闸门/账本/频控，多出「等人确认」这一段（plan §13.3 第 1 条）。
// 同包不新建包的理由写在那一节：投递与打招呼是同一件事的上下游，复用的四项已经在包里。
export * from './deliver.js';
// 择机投递的时机规则（spec 5.7-03）：与投递本体同包，单独一条导出是为了让真值表用例直接打到它。
export * from './deliver-timing.js';
// 投递记录（spec 3.7-02）是第六个：账本数额度，这张表记经过（递给哪个 JD、用的哪一版快照）。
// 它同包是因为只有 `outbound.deliver` 会写它，而它谁都不认识——只认 `store` 那一条连接。
export * from './delivery-record-store.js';
