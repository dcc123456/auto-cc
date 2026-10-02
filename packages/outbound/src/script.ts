/**
 * `outbound.script` 服务（spec 2.5-01 / 2.5-09 / 2.5-10 + 4.6-01 / 02 / 04 / 05 / 06 / 12）：话术生成入口。
 *
 * 它只管「内容」，不管「怎么发」——选择器、发送按钮、成功判据都在平台适配器里（plan §12.3）。
 * 五条立身之本：
 * 1. **模型只有一个入口**：本文件不出现任何端点，全部经 `llm.chat`（spec 2.5-12 的机检覆盖到这里）；
 * 2. **不可用要回落，且回落要能被看见**：模型没配或这次失败时改用本地模板，并把回落原因随结果返回，
 *    由调用方在界面播报（§12.2 采纳 browser-copilot 的立场但换判据——它抛错，我们要可见回落）；
 * 3. **要离开 app 的文本必须过黑名单**（AGENTS.md §8.4 事实锁定 + §8.5 个人数据脱敏的前置闸门）；
 * 4. **一条入口三类话术**（4.6-01）：`kind` 只切换文案与约束，装配、校验、回落决策共用一份——
 *    分型不是复制（§2.5），`greeting` 的现有入参与出参形状一字未改（4.6-11 的接口定型判据靠这个）；
 * 5. **说出来的每个数都要有出处**（4.6-02）：入参证据带 `refId`、产物回指 `evidenceRefs`，
 *    模型产出里没支撑的数字一律判不合格。禁发内容分两组（凭据 / 夸大与诱导承诺），两组同一条判据入口。
 *
 * 模板与提示词全部在注册表 `./prompts.ts`（spec 4.6-09，由 `scripts/check-prompts.ts` 机检），
 * 本文件只做装配、校验与回落决策。
 */
import { AppError, asApp, Service, type Context } from '@auto-cc/core';
import { z } from 'zod';
import { findUnsupportedClaims } from './claims.js';
import { buildScriptMessages, renderScriptTemplate, SCRIPT_PROMPT_VERSION } from './prompts.js';

/**
 * 知识库证据的一条（P4 已接：`kb.search` 的命中直接喂这里，plan §12.8）。
 *
 * `refId` 是**必填**的——spec 4.6-02 要求产物显式回指证据，而一个没有 id 的 `fact` 串
 * 事后无法核对"这句话到底来自库里哪一行"（2.5-09 的来源可追溯在证据这一层的落点）。
 * 值取 `kb.profile.search` 命中的 `chunkId`（entity 腿就是实体行 id），由调用方传入：
 * 话术服务不查库，这是 plan §4.6 裁定二（`outbound` 反向依赖 `resume-kb` 是 §4.1 禁止的横向引用）。
 */
export const scriptEvidenceSchema = z.strictObject({
  fact: z.string().min(1),
  refId: z.string().min(1),
});

/**
 * 话术分型（spec 4.6-01）：开场白、追问、拒绝应对。
 *
 * 顺序即"对话推进到哪一步"：`greeting` 是第一次接触，`follow-up` 是已有一轮之后往前推，
 * `rejection` 是对方拒绝后的收尾。三类都在招聘软件的同一个输入框里发出去，
 * 所以黑名单、长度、事实约束对三者一视同仁，只有文案与指涉对象不同。
 */
export const SCRIPT_KINDS = ['greeting', 'follow-up', 'rejection'] as const;

/** 话术分型（`SCRIPT_KINDS` 的取值）。 */
export type ScriptKind = (typeof SCRIPT_KINDS)[number];

/**
 * 语气档位（spec 4.6-04 的"风格受配置约束"）：正式 / 亲和 / 简短。
 *
 * 做成配置而不是入参：一个用户的话术风格是稳定偏好，逐条请求挑风格等于把界面做成设置页。
 */
export const SCRIPT_TONES = ['formal', 'warm', 'brief'] as const;

/** 语气档位（`SCRIPT_TONES` 的取值）。 */
export type ScriptTone = (typeof SCRIPT_TONES)[number];

/**
 * 生成入参：JD 的关键字段 + 可选证据 + 分型。岗位名与公司名缺一即拒，不生成空话术。
 *
 * `kind` 带默认值，所以 2.5 侧现存的调用（只给 jdId/title/company/keywords）一字不改仍是开场白。
 * `recruiterMessage` 是对方最后那句话：**追问与拒绝应对离不开它**（没有指涉对象的追问就是重发自我介绍），
 * 但开场白不该被它绑住，所以这里是可选字段 + 服务里按 `kind` 判必填，而不是在 schema 上做分支。
 */
export const scriptRequestSchema = z.strictObject({
  jdId: z.string().min(1),
  title: z.string().min(1),
  company: z.string().min(1),
  keywords: z.array(z.string().min(1)).default([]),
  evidence: z.array(scriptEvidenceSchema).default([]),
  kind: z.enum(SCRIPT_KINDS).default('greeting'),
  /** 对方最后一条消息原文（上限 200 字：再长的内容属于对话记录，不属于一句提示） */
  recruiterMessage: z.string().min(1).max(200).optional(),
});

/** 需要引用对方原话的那两类（`greeting` 不在内）。 */
const KINDS_NEEDING_QUOTE: readonly ScriptKind[] = ['follow-up', 'rejection'];

/** 内置的三条发送前黑名单（plan §12.4）：手机号、身份证、"验证码/密码"后跟的数字串。导出以便测试与配置文档共用一份。 */
export const DEFAULT_FORBIDDEN_PATTERNS = [
  String.raw`1[3-9]\d{9}`,
  String.raw`\d{17}[\dXx]`,
  String.raw`(?:验证码|密码)[：:\s]*\d{6,}`,
];

/**
 * 内置的夸大/诱导承诺黑名单（spec 4.6-05），与凭据那组分列两组。
 *
 * 为什么分两组而不是并进 `DEFAULT_FORBIDDEN_PATTERNS`：两组的**处置语义不同**——凭据是"这条内容会伤人"，
 * 夸大承诺是"这句话我们替用户许不了"，界面上的提示语（4.6-d）和复盘时想知道的问题不是一回事。
 * 分开还让 `check-compliance-redlines` 之外多一处可逐条核对的清单。
 *
 * 每条都按"形状"写而不是按整句匹配，因为中文说法太多；代价是可能误伤正常句子，
 * 所以每条都刻意收窄：`包过` 前面带 `(?<!含)`，否则「包括」里就有一次命中。
 */
export const DEFAULT_OVERCLAIM_PATTERNS = [
  String.raw`(?<!含)包(?:过|录取|进|offer|Offer)`,
  String.raw`保证(?:录用|入职|通过|拿到)`,
  String.raw`一定(?:能|会)?(?:录用|入职|拿到|通过)`,
  String.raw`(?:加|换|留|有)\s*(?:我)?\s*(?:微信|VX|vx|QQ|qq)`,
  String.raw`付费内推|收费内推|押金|保证金|培训费|内推码`,
  String.raw`扫码|点击链接|戳.{0,4}链接`,
];

export const outboundScriptSchema = z.strictObject({
  /**
   * 模板/prompt 版本（spec 2.5-09）：默认值取自文案旁边的 `SCRIPT_PROMPT_VERSION`，
   * 所以改注册表的人在同一次改动里就看到它；配置显式给了就以配置为准（A/B 文案时用）。
   */
  scriptVersion: z.string().min(1).default(SCRIPT_PROMPT_VERSION),
  /**
   * 话术长度上限（字符，spec 4.6-04）。
   *
   * 模型产出超限**先按句末截断**（4.6-04：截成完整句，不半句话糊在对方屏幕上），
   * 切不出完整句才回落；模板产出超限仍判缺陷——那是我们自己写的文案与配置互相矛盾，静默截断会掩盖它。
   */
  maxChars: z.number().int().min(20).max(1000).default(200),
  /** 语气档位（spec 4.6-04 的"风格受配置约束"：模型路与模板路都有落点，见 `prompts.ts` 的 `TONE_COPY`） */
  tone: z.enum(SCRIPT_TONES).default('formal'),
  /** 黑名单正则源串；配置里给了就整体替换内置三条，方便后续加规则而不改代码。 */
  forbiddenPatterns: z.array(z.string().min(1)).default(DEFAULT_FORBIDDEN_PATTERNS),
  /** 夸大/诱导承诺的正则源串（spec 4.6-05），覆盖口径与上面那条一致：给了就整体替换内置那六条。 */
  overclaimPatterns: z.array(z.string().min(1)).default(DEFAULT_OVERCLAIM_PATTERNS),
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
  /**
   * 本次产的是哪一类话术（spec 4.6-01）：界面据此选标题与「模板」标识的措辞，
   * 账本侧 4.6-e 把它一起写进 `source`。**新增键而不改上面任何键**（4.6-11：P2 不二次加工）。
   */
  kind: ScriptKind;
  /**
   * 这句话术引用了哪些证据（spec 4.6-02）：入参 `evidence[].refId` 的去重原样回指，
   * 顺序保持入参顺序。空数组是**有意义的读数**——"这条话术没有任何知识库依据"，
   * 界面据此显示「未引用经历」而不是假装它个性化过（4.6-06 的「不冒充个性化」在证据层的同一口径）。
   */
  evidenceRefs: string[];
}

/** 一句中文话术里可作为截断点的句末标点（半角与分号一并认：模型经常混用）。 */
const SENTENCE_ENDINGS = '。！？!?；;';

/**
 * 把超长文案截到最后一个**完整句**（spec 4.6-04：超限自动截断为完整句）。
 *
 * 只在 `maxChars` 之内找句末标点，找不到就返回 null 而不是硬切——半句话发出去比不发更糟，
 * 调用方据 null 回落模板。半角标点后可能跟着空格，空格不属于句子，所以结果会再收尾一次。
 * @param text 模型产出的正文（已 trim）
 * @param maxChars 长度上限（字符，与配置同一口径，单位是 UTF-16 码元——与 `.length` 一致）
 * @returns 不超过上限、以句末标点收尾的截断串；上限内切不出完整句时为 null
 */
export function truncateToSentence(text: string, maxChars: number): string | null {
  if (text.length <= maxChars) return text;
  const window = text.slice(0, maxChars);
  let boundary = -1;
  for (let index = window.length - 1; index >= 0; index -= 1) {
    if (SENTENCE_ENDINGS.includes(window[index] ?? '')) {
      boundary = index;
      break;
    }
  }
  if (boundary < 0) return null;
  return window.slice(0, boundary + 1).trimEnd();
}

export class OutboundScriptService extends Service {
  static provide = 'outbound.script';
  static Config = outboundScriptSchema;
  // 模型出口缺席时本服务进 PENDING：话术生成没有"静默不发网络"的替代路径，装上半个不如不装。
  static inject = ['llm.chat'];

  private readonly options: OutboundScriptConfig;
  private readonly forbidden: RegExp[];
  private readonly overclaim: RegExp[];

  constructor(ctx: Context, options: OutboundScriptConfig) {
    // 第二个实参是 cordis 校验后的配置（AGENTS.md §9 实测 1.3）。
    super(ctx, 'outbound.script');
    this.options = options;
    this.forbidden = options.forbiddenPatterns.map((source) => new RegExp(source));
    this.overclaim = options.overclaimPatterns.map((source) => new RegExp(source));
  }

  /**
   * 找出文案命中的第一条禁发表述（两组黑名单一次判完）。
   *
   * 只留这一个判据入口：模型腿（`askModel`，命中就可见回落）与发送腿（`assertSendable`，命中就硬拦）
   * 处置不同，但**"什么算禁发"必须一字不差**——两处各写一遍就会各判各的（§2.5）。
   * @param text 待判文案
   * @returns 命中组别与组内序号（从 1 起，界面与账本按它说话）；没命中为 null
   */
  private firstBlocker = (text: string): { group: 'credential' | 'overclaim'; rule: number } | null => {
    const credentialHit = this.forbidden.findIndex((pattern) => pattern.test(text));
    if (credentialHit >= 0) return { group: 'credential', rule: credentialHit + 1 };
    const overclaimHit = this.overclaim.findIndex((pattern) => pattern.test(text));
    if (overclaimHit >= 0) return { group: 'overclaim', rule: overclaimHit + 1 };
    return null;
  };

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
    const blocker = this.firstBlocker(text);
    if (blocker !== null) {
      throw new AppError(
        'OUTBOUND_FORBIDDEN_CONTENT',
        `文案命中禁发内容（第 ${String(blocker.rule)} 条规则），已阻止发送`,
        'outbound.script',
        { rule: blocker.rule, group: blocker.group, origin },
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
   * 生成一条话术（三类共用一个入口，spec 4.6-01）：先问模型，不可用或不合格则回落模板。
   *
   * 分型只改三件事：要哪份文案（`prompts.ts` 按 `kind` 取）、必须带对方原话的两类的入参校验、
   * 以及结果里回传的 `kind`。校验、黑名单、回落决策一条都不分叉。
   * @param raw 生成入参（JD 关键字段 + 可选证据 + `kind`）；缺岗位名/公司名直接以 `INVALID_ARGUMENT` 失败，
   *        追问/拒绝应对缺 `recruiterMessage` 同样失败——没有指涉对象的追问等于重发自我介绍
   * @returns 已过校验的话术；`origin` 与 `fallbackReason` 供界面播报（spec 2.5-01 / 4.6-06）
   * @throws 入参不合法，或回落后的模板文本仍过不了黑名单/长度时失败——两条路都不通才抛
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
    if (KINDS_NEEDING_QUOTE.includes(request.kind) && request.recruiterMessage === undefined) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `${request.kind} 类话术需要对方最后那条消息（recruiterMessage）才能成立，请先取到对话记录再生成`,
        'outbound.script',
        { kind: request.kind },
      );
    }
    // 引用清单在**问模型之前**就定下来：它是产物的回指，不是模型选了什么才算数（spec 4.6-02）。
    // 去重是因为同一个实体可能既作为经历又作为成就被喂进来两次。
    const evidenceRefs = [...new Set(request.evidence.map((item) => item.refId))];
    const attempt = await this.askModel(request);
    if (attempt.ok) {
      this.assertSendable(attempt.text, 'model');
      this.ctx.logger.info(
        `话术由模型产出：${request.kind} · ${String(attempt.text.length)} 字 · 版本 ${this.options.scriptVersion} · 引用 ${String(evidenceRefs.length)} 条`,
      );
      return {
        text: attempt.text,
        origin: 'model',
        scriptVersion: this.options.scriptVersion,
        jdId: request.jdId,
        kind: request.kind,
        evidenceRefs,
      };
    }
    // 回落不是失败：流程继续，但原因必须跟着结果走上前，界面才知道该说什么。
    const text = renderScriptTemplate(request, this.options.tone);
    this.assertSendable(text, 'template');
    this.ctx.logger.warn(`话术回落模板：${request.kind} · ${attempt.reason}`);
    return {
      text,
      origin: 'template',
      fallbackReason: attempt.reason,
      scriptVersion: this.options.scriptVersion,
      jdId: request.jdId,
      kind: request.kind,
      evidenceRefs,
    };
  };

  /**
   * 问一次模型，把各种失败收敛成"能不能用"，不在这里决定回落策略。
   *
   * 四道判据的顺序是有理由的：① **先查完整文本的禁发内容**（凭据或夸大承诺出现在任何一句里都说明这条回答
   * 不可信，也免得"截断刚好把手机号截掉了"这种蒙混过关）；② 再按句末截断；③ 截完才要求点明岗位/公司；
   * ④ 最后查**无依据的数字**——放在截断之后是因为要判的是"实际发出去那一条"有没有编。
   * @param request 已校验的生成入参
   * @returns 成功时带正文；失败时带一句可直接播报的原因（不带上游堆栈）
   */
  private askModel = async (
    request: ScriptRequest,
  ): Promise<{ ok: true; text: string } | { ok: false; reason: string }> => {
    const llm = asApp(this.ctx)['llm.chat'];
    let rawText: string;
    try {
      const completion = await llm.complete({
        messages: buildScriptMessages(request, this.options.maxChars, this.options.tone),
      });
      rawText = completion.text.trim();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // 模型侧的入参错误说明是我们的问题，回落只会掩盖它。
      if (cause instanceof AppError && cause.code === 'INVALID_ARGUMENT') throw cause;
      return { ok: false, reason: message };
    }
    const blocker = this.firstBlocker(rawText);
    if (blocker !== null) {
      return {
        ok: false,
        reason: blocker.group === 'credential' ? '模型产出含禁发内容' : '模型产出含夸大或诱导承诺的表述',
      };
    }
    const text = truncateToSentence(rawText, this.options.maxChars);
    if (text === null) {
      return { ok: false, reason: `模型产出超过 ${String(this.options.maxChars)} 字且切不出完整句` };
    }
    // 缺关键字段的文案等于把"前端工程师"发成空话（§12.2 采纳参考项目的"空引用拒填"机制，
    // 但判据换成回落：模型不合格不该让整步失败）。截断之后才查，是因为要保住的是**发出去那一条**的完整性。
    if (!text.includes(request.title) && !text.includes(request.company)) {
      return { ok: false, reason: '模型产出缺少岗位名/公司名' };
    }
    // 无依据的数字（spec 4.6-02）：只认这次真喂进去的事实——证据正文、岗位名、公司名、关键词、对方原话。
    // JD 正文里的数字不在支撑面里（入参只有那四个字段），要让它进话术得先经 4.4 拆解或 4.5 入库，
    // 而不是在这里放宽成"模型说来自 JD 就算数"——那等于把 §8.4 的事实锁定交还给模型自查。
    const unsupported = findUnsupportedClaims(text, [
      ...request.evidence.map((item) => item.fact),
      request.title,
      request.company,
      ...request.keywords,
      request.recruiterMessage ?? '',
    ]);
    if (unsupported.length > 0) {
      return { ok: false, reason: `模型产出含没有证据支撑的数字：${unsupported.join('、')}` };
    }
    return { ok: true, text };
  };

  [Service.init](): void {
    this.ctx.logger.info(
      `话术生成就绪：版本 ${this.options.scriptVersion} · ${SCRIPT_KINDS.join('/')} 三类 · ` +
        `上限 ${String(this.options.maxChars)} 字 · 语气 ${this.options.tone} · ` +
        `禁发规则 凭据 ${String(this.forbidden.length)} 条/夸大诱导 ${String(this.overclaim.length)} 条 · ` +
        `模型 ${asApp(this.ctx)['llm.chat'].status().available ? '可用' : '不可用（走模板回落）'}`,
    );
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'outbound.script': OutboundScriptService;
  }
}
