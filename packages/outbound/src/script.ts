/**
 * `outbound.script` 服务（spec 2.5-01 / 2.5-09 / 2.5-10）：打招呼开场白的生成入口。
 *
 * 它只管「内容」，不管「怎么发」——选择器、发送按钮、成功判据都在平台适配器里（plan §12.3）。
 * 三条立身之本：
 * 1. **模型只有一个入口**：本文件不出现任何端点，全部经 `llm.chat`（spec 2.5-12 的机检覆盖到这里）；
 * 2. **不可用要回落，且回落要能被看见**：模型没配或这次失败时改用本地模板，并把回落原因随结果返回，
 *    由调用方在界面播报（§12.2 采纳 browser-copilot 的立场但换判据——它抛错，我们要可见回落）；
 * 3. **要离开 app 的文本必须过黑名单**（AGENTS.md §8.4 事实锁定 + §8.5 个人数据脱敏的前置闸门）。
 *
 * 模板与提示词全部是本仓库自写的中文表达，未从任何参考项目搬运（plan §12.7 的许可约束）。
 * 自 4.6-a 起，那些字面量搬进本包的注册表 `./prompts.ts`（spec 4.6-09：一包的 prompt 只许一处，
 * 由 `scripts/check-prompts.ts` 机检），本文件只做装配、校验与回落决策。
 */
import { AppError, asApp, Service, type Context } from '@auto-cc/core';
import { z } from 'zod';
import { buildGreetingMessages, renderGreetingTemplate } from './prompts.js';

/** 知识库证据的一条（P4 未接前允许整体为空数组，plan §12.8）。 */
export const scriptEvidenceSchema = z.strictObject({
  fact: z.string().min(1),
});

/** 生成入参：JD 的关键字段 + 可选证据。岗位名与公司名缺一即拒，不生成空话术。 */
export const scriptRequestSchema = z.strictObject({
  jdId: z.string().min(1),
  title: z.string().min(1),
  company: z.string().min(1),
  keywords: z.array(z.string().min(1)).default([]),
  evidence: z.array(scriptEvidenceSchema).default([]),
});

/** 内置的三条发送前黑名单（plan §12.4）：手机号、身份证、"验证码/密码"后跟的数字串。导出以便测试与配置文档共用一份。 */
export const DEFAULT_FORBIDDEN_PATTERNS = [
  String.raw`1[3-9]\d{9}`,
  String.raw`\d{17}[\dXx]`,
  String.raw`(?:验证码|密码)[：:\s]*\d{6,}`,
];

export const outboundScriptSchema = z.strictObject({
  /** 模板/prompt 版本（spec 2.5-09）：改文案必须同时改它，否则复盘时分不清是哪一版产出的。 */
  scriptVersion: z.string().min(1).default('v1'),
  /** 开场白长度上限（字符）。超长判为不合格，回落模板而不是截断——截断会切出半句话。 */
  maxChars: z.number().int().min(20).max(1000).default(200),
  /** 黑名单正则源串；配置里给了就整体替换内置三条，方便后续加规则而不改代码。 */
  forbiddenPatterns: z.array(z.string().min(1)).default(DEFAULT_FORBIDDEN_PATTERNS),
});

/** 校验后的配置形状。 */
export type OutboundScriptConfig = z.infer<typeof outboundScriptSchema>;

/**
 * 文案的来路（spec 2.5-10）：模型产出、模板回落、用户在界面上手改。
 * 黑名单对三路一视同仁——手改的那一路恰恰是最容易漏进去手机号的一路。
 */
export type ScriptOrigin = 'model' | 'template' | 'manual';

/** 生成入参的推断类型。 */
export type ScriptRequest = z.infer<typeof scriptRequestSchema>;

/** 生成结果的界面视图（spec 2.5-01 的"不静默失败"就落在这个 `origin` + `fallbackReason` 上）。 */
export interface ScriptDraftView {
  /** 最终可发送的文案（已过黑名单与长度校验） */
  text: string;
  /** 内容来源：模型产出，或本地模板回落。`generate` 不会产出 manual，所以这里比 `ScriptOrigin` 窄。 */
  origin: 'model' | 'template';
  /** `origin` 为 template 时必填：模型为什么没用上，界面按它播报 */
  fallbackReason?: string;
  /** 本次用的模板版本，随结果一起进账本的 `source` 列（spec 2.5-09） */
  scriptVersion: string;
  /** 归属的 JD id，用于把文案与目标对上 */
  jdId: string;
}

export class OutboundScriptService extends Service {
  static provide = 'outbound.script';
  static Config = outboundScriptSchema;
  // 模型出口缺席时本服务进 PENDING：话术生成没有"静默不发网络"的替代路径，装上半个不如不装。
  static inject = ['llm.chat'];

  private readonly options: OutboundScriptConfig;
  private readonly forbidden: RegExp[];

  constructor(ctx: Context, options: OutboundScriptConfig) {
    // 第二个实参是 cordis 校验后的配置（AGENTS.md §9 实测 1.3）。
    super(ctx, 'outbound.script');
    this.options = options;
    this.forbidden = options.forbiddenPatterns.map((source) => new RegExp(source));
  }

  /**
   * 发送前黑名单与长度校验（spec 2.5-10）。
   *
   * 暴露成方法而不是只在本包内部用：`outbound.greet` 在真正下发前要对**最终文本**再查一次，
   * 因为用户可能在界面上改过话术——那是文本离开 app 的边界。
   * @param text 将要发往页面的文本
   * @param origin 内容来源，只用于报错时说得清是哪一路
   * @throws 命中黑名单时以 `OUTBOUND_FORBIDDEN_CONTENT` 失败（detail 带第几条规则）；超长同理
   */
  assertSendable = (text: string, origin: ScriptOrigin): void => {
    const hitIndex = this.forbidden.findIndex((pattern) => pattern.test(text));
    if (hitIndex >= 0) {
      throw new AppError(
        'OUTBOUND_FORBIDDEN_CONTENT',
        `文案命中禁发内容（第 ${String(hitIndex + 1)} 条规则），已阻止发送`,
        'outbound.script',
        { rule: hitIndex + 1, origin },
      );
    }
    if (text.length > this.options.maxChars) {
      throw new AppError(
        'OUTBOUND_FORBIDDEN_CONTENT',
        `文案长度 ${String(text.length)} 超过上限 ${String(this.options.maxChars)} 字`,
        'outbound.script',
        { rule: 0, origin, reason: 'over-length' },
      );
    }
  };

  /**
   * 生成一条开场白：先问模型，不可用或不合格则回落模板。
   * @param raw 生成入参（JD 关键字段 + 可选证据）；缺岗位名/公司名直接以 `INVALID_ARGUMENT` 失败
   * @returns 已过校验的话术；`origin` 与 `fallbackReason` 供界面播报（spec 2.5-01）
   * @throws 入参不合法，或回落后的模板文本仍过不了黑名单时失败——两条路都不通才抛
   */
  generate = async (raw: unknown): Promise<ScriptDraftView> => {
    const parsed = scriptRequestSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `话术入参不合法：${parsed.error.issues[0]?.message ?? ''}`,
        'outbound.script',
      );
    }
    const request = parsed.data;
    const attempt = await this.askModel(request);
    if (attempt.ok) {
      this.assertSendable(attempt.text, 'model');
      this.ctx.logger.info(`话术由模型产出：${String(attempt.text.length)} 字 · 版本 ${this.options.scriptVersion}`);
      return { text: attempt.text, origin: 'model', scriptVersion: this.options.scriptVersion, jdId: request.jdId };
    }
    // 回落不是失败：流程继续，但原因必须跟着结果走上前，界面才知道该说什么。
    const text = renderGreetingTemplate(request);
    this.assertSendable(text, 'template');
    this.ctx.logger.warn(`话术回落模板：${attempt.reason}`);
    return {
      text,
      origin: 'template',
      fallbackReason: attempt.reason,
      scriptVersion: this.options.scriptVersion,
      jdId: request.jdId,
    };
  };

  /**
   * 问一次模型，把各种失败收敛成"能不能用"，不在这里决定回落策略。
   * @param request 已校验的生成入参
   * @returns 成功时带正文；失败时带一句可直接播报的原因（不带上游堆栈）
   */
  private askModel = async (
    request: ScriptRequest,
  ): Promise<{ ok: true; text: string } | { ok: false; reason: string }> => {
    const llm = asApp(this.ctx)['llm.chat'];
    let text: string;
    try {
      const completion = await llm.complete({ messages: buildGreetingMessages(request, this.options.maxChars) });
      text = completion.text.trim();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // 模型侧的入参错误说明是我们的问题，回落只会掩盖它。
      if (cause instanceof AppError && cause.code === 'INVALID_ARGUMENT') throw cause;
      return { ok: false, reason: message };
    }
    // 缺关键字段的文案等于把"前端工程师"发成空话（§12.2 采纳参考项目的"空引用拒填"机制，
    // 但判据换成回落：模型不合格不该让整步失败）。
    if (!text.includes(request.title) && !text.includes(request.company)) {
      return { ok: false, reason: '模型产出缺少岗位名/公司名' };
    }
    if (text.length > this.options.maxChars) {
      return { ok: false, reason: `模型产出超过 ${String(this.options.maxChars)} 字` };
    }
    if (this.forbidden.some((pattern) => pattern.test(text))) {
      return { ok: false, reason: '模型产出含禁发内容' };
    }
    return { ok: true, text };
  };

  [Service.init](): void {
    this.ctx.logger.info(
      `话术生成就绪：版本 ${this.options.scriptVersion} · 上限 ${String(this.options.maxChars)} 字 · 模型 ${
        asApp(this.ctx)['llm.chat'].status().available ? '可用' : '不可用（走模板回落）'
      }`,
    );
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'outbound.script': OutboundScriptService;
  }
}
