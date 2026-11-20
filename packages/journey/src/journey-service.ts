/**
 * `journey` 服务（M2-B spec 10.3-01…03）：把「母版意向 → 按意向搜岗 → 可解释匹配 →
 * 定制简历与招呼草稿 → 面试材料」收成一条可追踪的链。
 *
 * 为什么单开一个 L3 包（plan §10.5 已登记理由与边界）：这条链要同时调 `kb.profile` / `kb.gap` /
 * `resume.generate` / `resume.doc`（L2 简历域）与 `jd.capture` / `jd.store`（L2 平台域）以及
 * `outbound.script` / `llm.chat`。放进任何一个已有的 L2 包都会新开一条同级横向依赖（AGENTS.md §4.1），
 * 放进 `agent` 又会让「求职主链」变成对话循环的私产。L3 只做编排，不复制任何判据：
 * 匹配理由来自 `kb.gap`、事实校验来自 `resume.generate`、招呼草稿来自 `outbound.script`、
 * 模型出口只有 `llm.chat`。
 *
 * 版本口径（spec 10.3-01 的「同一版本上下文」）：`resumeVersion = doc:<docId>:<内容哈希前 12 位>`，
 * `jdVersion = sha256(JD 正文) 前 12 位`；两者原样进匹配行、定制回执与面试材料，任何一步换版本都会看得见。
 */
import { AppError, Service, asApp, executorRegistryOf, registerAgentTools, toolResult, agentTool } from '@auto-cc/core';
import type { Context, WorkflowNodeExecutor } from '@auto-cc/core';
import { contentHash, type ResumeDocService } from '@auto-cc/plugin-resume-doc';
import type {
  GapReportView,
  KbGapService,
  KbIntentView,
  KbProfileService,
  ResumeGenerateService,
} from '@auto-cc/plugin-resume-kb';
import type { JdCaptureService, JdStoreService } from '@auto-cc/plugin-platform-boss';
import type { OutboundScriptService } from '@auto-cc/plugin-outbound';
import type { LlmChatService } from '@auto-cc/plugin-llm';
import type {
  JobRowView,
  JourneyIntentView,
  JourneyInterviewView,
  JourneyJobMatchView,
  JourneySearchView,
  JourneyTailorView,
} from '@auto-cc/shared';
import { z } from 'zod';
import {
  intentViewOf,
  jdVersionOf,
  matchJob,
  parseInterviewJson,
  requirementIdOf,
  resumeVersionOf,
  sortMatches,
  validateInterviewKit,
  type InterviewContext,
} from './match.js';
import {
  buildInterviewMessages,
  JOURNEY_INTERVIEW_MAX_TOKENS,
  JOURNEY_INTERVIEW_PROMPT_VERSION,
  JOURNEY_MODEL_ID,
  type InterviewFact,
  type InterviewRequirement,
} from './prompts.js';

/** 本服务暂无可调项；`strictObject` 让清单里写错的键在挂载期就报错。 */
export const journeySchema = z.strictObject({});

/** 校验后的配置形状（装配与测试引用它，而不是手写一遍推断）。 */
export type JourneyConfig = z.infer<typeof journeySchema>;

/** 工作流节点名：三个能力各一格，参数与工具面同口径（`docId` / `jobId` / `platform`）。 */
export const JOURNEY_SEARCH_KIND = 'journey.search';
export const JOURNEY_TAILOR_KIND = 'journey.tailor';
export const JOURNEY_INTERVIEW_KIND = 'journey.interview';

/** 搜索入参的下限与上限：至少三个岗位才谈得上「可解释匹配」，上限防一次捞出整库。 */
const MIN_MATCHES = 3;
const MAX_CAPTURE = 20;

/** 把节点参数里的字符串读出来（缺键或非字符串都返回 null，由调用方报缺参数）。 */
function paramString(value: string | number | boolean | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export class JourneyService extends Service {
  static provide = 'journey';
  static Config = journeySchema;
  // 全是 L2 服务的名字（不是包 import）：编排层只认契约，具体实现由装配清单决定装谁。
  static inject = [
    'resume.doc',
    'kb.profile',
    'kb.gap',
    'resume.generate',
    'jd.capture',
    'jd.store',
    'outbound.script',
    'llm.chat',
  ];

  constructor(ctx: Context, _config: JourneyConfig) {
    super(ctx, 'journey');
  }

  /** 文档存储：版本哈希与变体正文都从它现读，本服务不缓存文档内容。 */
  private get docs(): ResumeDocService {
    return asApp(this.ctx)['resume.doc'];
  }

  /** 知识库：意向四格与实体证据正文的唯一来源。 */
  private get profile(): KbProfileService {
    return asApp(this.ctx)['kb.profile'];
  }

  /** 缺口比对：匹配理由的唯一来源。 */
  private get gap(): KbGapService {
    return asApp(this.ctx)['kb.gap'];
  }

  /** 生成轨：定制简历与事实校验的唯一入口（本服务不自己校验、不自己拼提示词）。 */
  private get generate(): ResumeGenerateService {
    return asApp(this.ctx)['resume.generate'];
  }

  /** 抓取编排：按意向搜岗的唯一入口（本服务不直连适配器）。 */
  private get capture(): JdCaptureService {
    return asApp(this.ctx)['jd.capture'];
  }

  /** JD 库：岗位正文与标题的现读口。 */
  private get jobs(): JdStoreService {
    return asApp(this.ctx)['jd.store'];
  }

  /** 话术生成：招呼草稿的唯一入口。 */
  private get script(): OutboundScriptService {
    return asApp(this.ctx)['outbound.script'];
  }

  /** 模型出口：全仓唯一，本服务不新建客户端。 */
  private get llm(): LlmChatService {
    return asApp(this.ctx)['llm.chat'];
  }

  /**
   * 载入一份文档并算版本键；不存在或损坏时结构化失败，不猜。
   * @param docId 文档 id
   * @returns 文档正文与 `doc:<id>:<hash12>` 版本
   * @throws `KB_SOURCE_MISSING`（不存在/损坏）
   */
  private loadVersioned(docId: string): { hash: string; resumeVersion: string } {
    const loaded = this.docs.load(docId);
    if (loaded.status !== 'found') {
      throw new AppError(
        'KB_SOURCE_MISSING',
        `简历 ${docId} ${loaded.status === 'missing' ? '不存在' : '已损坏'}`,
        'journey',
        {
          docId,
        },
      );
    }
    const hash = contentHash(loaded.document);
    return { hash, resumeVersion: resumeVersionOf(docId, hash) };
  }

  /**
   * 读一份母版的求职意向并组装视图。
   * @param docId 文档 id
   * @returns 意向视图（含搜索条件与缺失格）
   * @throws `KB_SOURCE_MISSING` / `INVALID_ARGUMENT`（文档没有意向区块）
   */
  intent = (docId: string): JourneyIntentView => {
    const version = this.loadVersioned(docId);
    const intent: KbIntentView | null = this.profile.intent(docId);
    if (!intent) {
      throw new AppError('INVALID_ARGUMENT', `简历 ${docId} 没有求职意向区块：先在简历页填四条意向再搜岗`, 'journey', {
        docId,
      });
    }
    return intentViewOf(intent, docId, version.resumeVersion);
  };

  /**
   * 按意向自动搜岗，并逐岗给出可追溯的匹配理由。
   * @param input `docId` 必填；`platform` 省略时用抓取编排的默认平台；`limit` 至少 3
   * @returns 意向 + 至少三个岗位的匹配行；不足三个时**失败**而不是补样例
   * @throws `INVALID_ARGUMENT`（意向缺期望岗位）、`JOURNEY_MATCH_INSUFFICIENT`（带抓取读数）
   */
  search = async (input: { docId: string; platform?: string; limit?: number }): Promise<JourneySearchView> => {
    const intent = this.intent(input.docId);
    if (intent.criteria.keyword === '') {
      throw new AppError(
        'INVALID_ARGUMENT',
        `简历 ${input.docId} 的期望岗位为空：意向没填就不代替人决定搜什么`,
        'journey',
        {
          docId: input.docId,
          missingFields: intent.missingFields,
        },
      );
    }
    const target = Math.min(MAX_CAPTURE, Math.max(MIN_MATCHES, input.limit ?? MIN_MATCHES));
    const platform = input.platform ?? this.capture.status().platform;
    const run = await this.capture.run(
      { keyword: intent.criteria.keyword, city: intent.criteria.city ?? undefined, limit: target },
      input.platform,
    );
    const capturedIds = run.captured.map((item) => item.jobId);
    const rows = this.jobs
      .list(MAX_CAPTURE * 5, { platform })
      .rows.filter((row) => capturedIds.includes(row.jobId) && row.description.trim() !== '');
    const matches: JourneyJobMatchView[] = [];
    for (const row of rows) {
      const report: GapReportView = await this.gap.report(row.description, { sourceDocId: input.docId });
      matches.push(matchJob(row, report));
    }
    // 可解释门槛：**每个返回岗位至少 1 条可回指要求行**。「有岗位但 0 条理由」不算可解释——
    // 否则判据「每个匹配理由可追溯到简历事实和 JD 要求」在空数组上恒真，三个岗位全是空理由也能过（10.3-01 缺陷）。
    const explainable = matches.filter((match) => match.requirements.length > 0);
    const sorted = sortMatches(explainable);
    if (sorted.length < MIN_MATCHES) {
      throw new AppError(
        'JOURNEY_MATCH_INSUFFICIENT',
        `按意向「${intent.criteria.keyword}」只得到 ${String(sorted.length)} 个可解释岗位（<${String(MIN_MATCHES)}）：` +
          `抓取 ${String(capturedIds.length)} 个，其中 ${String(matches.length - explainable.length)} 个没有任何可回指要求行`,
        'journey',
        {
          captured: capturedIds.length,
          eligible: sorted.length,
          unexplainable: matches.length - explainable.length,
          keyword: intent.criteria.keyword,
        },
      );
    }
    this.ctx.logger.info(
      `按意向搜岗：简历 ${input.docId} · 关键词「${intent.criteria.keyword}」· 抓取 ${String(capturedIds.length)} 个 · ` +
        `可解释 ${String(sorted.length)} 个 · 版本 ${intent.resumeVersion}`,
    );
    return {
      intent,
      platform,
      capturedJobIds: capturedIds,
      jobs: sorted,
      insufficient: false,
    };
  };

  /**
   * 找出某个岗位的库内行；正文为空时不能拿来生成。
   * @param jobId 平台侧岗位 id
   * @param platform 平台标识
   * @returns 库内岗位行
   * @throws `INVALID_ARGUMENT`（库里没有它或只有摘要）
   */
  private jobRow(jobId: string, platform?: string): { row: JobRowView; platform: string } {
    const resolvedPlatform = platform ?? this.capture.status().platform;
    const row = this.jobs
      .list(MAX_CAPTURE * 5, { platform: resolvedPlatform })
      .rows.find((item) => item.jobId === jobId);
    if (!row) {
      throw new AppError('INVALID_ARGUMENT', `库里没有岗位 ${jobId}：先按意向搜岗再定制`, 'journey', { jobId });
    }
    if (row.description.trim() === '') {
      throw new AppError('INVALID_ARGUMENT', `岗位 ${jobId} 只有摘要、没有 JD 正文：先补详情再定制`, 'journey', {
        jobId,
      });
    }
    return { row, platform: resolvedPlatform };
  }

  /**
   * 收集一条证据的正文（只给 id 与正文，不带联系方式）。
   * @param ids `kb.gap` 给出的证据 id
   * @returns 可喂给话术生成的事实数组；取不到正文的 id 被跳过
   */
  private factsOf(ids: readonly string[]): InterviewFact[] {
    const facts: InterviewFact[] = [];
    for (const id of ids) {
      const body = this.profile.evidenceBody(id);
      if (body && body.text.trim() !== '') facts.push({ factId: id, text: body.text.trim() });
    }
    return facts;
  }

  /**
   * 选定一岗生成定制简历与招呼草稿。
   * @param input `docId` 与 `jobId` 必填；`platform` 省略时用默认抓取平台
   * @returns 版本三元组、事实校验读数与招呼草稿；违规时整份失败
   * @throws `JOURNEY_FACT_BLOCKED`（事实违规，阻断后续外发）、`KB_GENERATION_*`、`KB_SOURCE_MISSING`
   */
  tailor = async (input: { docId: string; jobId: string; platform?: string }): Promise<JourneyTailorView> => {
    const base = this.loadVersioned(input.docId);
    const { row, platform } = this.jobRow(input.jobId, input.platform);
    const report = await this.gap.report(row.description, { sourceDocId: input.docId });
    const view = await this.generate.run(row.description, { docId: input.docId, jdId: row.jobId });
    if (!view.checks.ok || view.document === null) {
      throw new AppError(
        'JOURNEY_FACT_BLOCKED',
        `定制简历被事实校验拦下（${String(view.checks.violationCount)} 条违规）：不产生变体、不生成招呼、不得外发`,
        'journey',
        { docId: input.docId, jobId: row.jobId, violations: view.checks.violations, receiptId: view.receipt.id },
      );
    }
    const accepted = this.generate.accept(view.receipt.id, {
      acceptedIndexes: view.rewrites.map((_, index) => index),
      applyReorder: true,
    });
    const variant = this.loadVersioned(accepted.docId);
    const evidenceIds = report.rows
      .filter((item) => item.state !== 'missing')
      .flatMap((item) => item.evidence.map((evidence) => evidence.id))
      .slice(0, 3);
    const facts = this.factsOf(evidenceIds);
    const draft = await this.script.generate({
      jdId: row.jobId,
      title: row.title,
      company: row.company,
      evidence: facts.map((fact) => ({ fact: fact.text, refId: fact.factId })),
    });
    this.ctx.logger.info(
      `定制与招呼：岗位 ${row.jobId} · 母版 ${base.resumeVersion} · 变体 ${variant.resumeVersion} · ` +
        `JD ${jdVersionOf(row.description)} · 改写 ${String(accepted.appliedRewrites)} 处 · 违规 0 · 草稿来源 ${draft.origin}`,
    );
    return {
      docId: input.docId,
      platform,
      jobId: row.jobId,
      jdVersion: jdVersionOf(row.description),
      resumeVersion: base.resumeVersion,
      tailoredResumeVersion: variant.resumeVersion,
      tailoredDocId: accepted.docId,
      factCheckReceiptId: view.receipt.id,
      appliedRewrites: accepted.appliedRewrites,
      checks: { ok: true, violationCount: 0 },
      greeting: {
        text: draft.text,
        origin: draft.origin,
        scriptVersion: draft.scriptVersion,
        evidenceRefs: draft.evidenceRefs,
      },
    };
  };

  /**
   * 生成面试材料（自我介绍 / ≥8 条问答 / 准备清单），每条来源可回指。
   * @param input `docId` 与 `jobId` 必填；`platform` 省略时用默认抓取平台
   * @returns 带来源映射的材料；模型不可用与来源/数字冲突都明确失败
   * @throws `LLM_UNAVAILABLE` / `LLM_REQUEST_FAILED`（不回落样例）、`JOURNEY_MATERIAL_INVALID`（违规清单）
   */
  interview = async (input: { docId: string; jobId: string; platform?: string }): Promise<JourneyInterviewView> => {
    const base = this.loadVersioned(input.docId);
    const { row, platform } = this.jobRow(input.jobId, input.platform);
    const jdVersion = jdVersionOf(row.description);
    const report = await this.gap.report(row.description, { sourceDocId: input.docId });
    const requirements: InterviewRequirement[] = report.rows.map((item, index) => ({
      requirementId: requirementIdOf(jdVersion, index),
      label: item.item.label,
      kind: item.item.kind,
    }));
    const entities = this.profile.list({ sourceDocId: input.docId });
    const facts: InterviewFact[] = [];
    for (const entity of entities) {
      const body = this.profile.evidenceBody(entity.entityId);
      if (body && body.text.trim() !== '') facts.push({ factId: entity.entityId, text: body.text.trim() });
    }
    if (facts.length === 0) {
      throw new AppError('INVALID_ARGUMENT', `简历 ${input.docId} 没有可引用的事实：先导入并同步知识库`, 'journey', {
        docId: input.docId,
      });
    }
    const completion = await this.llm.complete({
      messages: buildInterviewMessages(row.description, facts, requirements),
      maxTokens: JOURNEY_INTERVIEW_MAX_TOKENS,
      temperature: 0,
    });
    const parsed = parseInterviewJson(completion.text);
    if (!parsed) {
      throw new AppError('JOURNEY_MATERIAL_INVALID', '模型回答不是合法 JSON：材料不成立，不用样例替代', 'journey', {
        jobId: row.jobId,
        promptVersion: JOURNEY_INTERVIEW_PROMPT_VERSION,
        model: JOURNEY_MODEL_ID,
      });
    }
    const context: InterviewContext = {
      docId: input.docId,
      jobId: row.jobId,
      jdVersion,
      resumeVersion: base.resumeVersion,
      facts,
      requirements,
      jdText: row.description,
      platform,
    };
    const checked = validateInterviewKit(parsed, context);
    if (!checked.ok || !checked.kit) {
      throw new AppError(
        'JOURNEY_MATERIAL_INVALID',
        `面试材料未过来源/数字校验（${String(checked.violations.length)} 条）：不返回材料，也不拿旧岗位内容顶替`,
        'journey',
        { jobId: row.jobId, violations: checked.violations, promptVersion: JOURNEY_INTERVIEW_PROMPT_VERSION },
      );
    }
    this.ctx.logger.info(
      `面试材料：岗位 ${row.jobId} · JD ${jdVersion} · 问答 ${String(checked.kit.qa.length)} 条 · ` +
        `准备 ${String(checked.kit.checklist.length)} 项 · 模型 ${completion.model}`,
    );
    return { ...checked.kit, platform };
  };

  /**
   * 工作流节点：按意向搜岗。
   * @param invocation 节点输入（`params.docId` / `platform` / `limit`）
   * @returns 无返回值；失败以结构化错误上浮
   */
  executeSearchNode: WorkflowNodeExecutor = async ({ spec }) => {
    const docId = paramString(spec.params.docId);
    if (!docId)
      throw new AppError('INVALID_ARGUMENT', `节点 ${spec.id} 缺少参数 docId`, JOURNEY_SEARCH_KIND, {
        nodeId: spec.id,
      });
    const platform = paramString(spec.params.platform) ?? undefined;
    await this.search({ docId, platform });
  };

  /**
   * 工作流节点：生成定制简历与招呼草稿。
   * @param invocation 节点输入（`params.docId` / `jobId` / `platform`）
   * @returns 无返回值
   */
  executeTailorNode: WorkflowNodeExecutor = async ({ spec }) => {
    const docId = paramString(spec.params.docId);
    const jobId = paramString(spec.params.jobId);
    if (!docId || !jobId) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `节点 ${spec.id} 缺少 ${!docId ? 'docId' : 'jobId'}`,
        JOURNEY_TAILOR_KIND,
        {
          nodeId: spec.id,
        },
      );
    }
    await this.tailor({ docId, jobId, platform: paramString(spec.params.platform) ?? undefined });
  };

  /**
   * 工作流节点：生成面试材料。
   * @param invocation 节点输入（`params.docId` / `jobId` / `platform`）
   * @returns 无返回值
   */
  executeInterviewNode: WorkflowNodeExecutor = async ({ spec }) => {
    const docId = paramString(spec.params.docId);
    const jobId = paramString(spec.params.jobId);
    if (!docId || !jobId) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `节点 ${spec.id} 缺少 ${!docId ? 'docId' : 'jobId'}`,
        JOURNEY_INTERVIEW_KIND,
        {
          nodeId: spec.id,
        },
      );
    }
    await this.interview({ docId, jobId, platform: paramString(spec.params.platform) ?? undefined });
  };

  [Service.init](): void {
    // 工作流登记处是可选的：工作流没装时这三条照样能从界面单次调用，只是没有节点可跑。
    const registry = executorRegistryOf(this.ctx);
    if (registry) {
      registry.register(JOURNEY_SEARCH_KIND, this.executeSearchNode);
      registry.register(JOURNEY_TAILOR_KIND, this.executeTailorNode);
      registry.register(JOURNEY_INTERVIEW_KIND, this.executeInterviewNode);
      this.ctx.effect(() => () => {
        registry.unregister(JOURNEY_SEARCH_KIND);
        registry.unregister(JOURNEY_TAILOR_KIND);
        registry.unregister(JOURNEY_INTERVIEW_KIND);
      });
    }
    // 三只能力同时登记进 agent 工具面（§5.9 的「不许孤岛页」：界面调用与对话调用是同一只服务）。
    const tools = registerAgentTools(this.ctx, [
      agentTool({
        id: 'journey.search',
        titleKey: 'agent.tool.labels.journeySearch',
        description: '按母版求职意向抓取岗位，并逐岗返回可追溯到简历事实与 JD 要求的匹配理由',
        input: z.strictObject({
          docId: z.string().min(1),
          platform: z.string().min(1).optional(),
          limit: z.number().int().min(3).max(MAX_CAPTURE).optional(),
        }),
        effect: 'read',
        requiresConfirmation: false,
        run: async ({ docId, platform, limit: target }) => {
          const view = await this.search({ docId, platform, limit: target });
          return toolResult(view, {
            summary: `按意向「${view.intent.criteria.keyword}」得到 ${String(view.jobs.length)} 个可解释岗位（简历版本 ${view.intent.resumeVersion}）`,
            evidenceRefs: view.jobs.map((job) => `job:${view.platform}/${job.jobId}`),
          });
        },
      }),
      agentTool({
        id: 'journey.tailor',
        titleKey: 'agent.tool.labels.journeyTailor',
        description: '为选定岗位生成定制简历与招呼草稿；事实校验不过即整份失败，不产生可发内容',
        input: z.strictObject({
          docId: z.string().min(1),
          jobId: z.string().min(1),
          platform: z.string().min(1).optional(),
        }),
        effect: 'local-write',
        requiresConfirmation: true,
        run: async ({ docId, jobId, platform }) => {
          const view = await this.tailor({ docId, jobId, platform });
          return toolResult(view, {
            summary: `岗位 ${view.jobId} 的定制与招呼草稿已生成（母版 ${view.resumeVersion} · 变体 ${view.tailoredResumeVersion ?? '无'}）`,
            evidenceRefs: [`job:${view.platform}/${view.jobId}`, `doc:${view.tailoredResumeVersion ?? view.docId}`],
          });
        },
      }),
      agentTool({
        id: 'journey.interview',
        titleKey: 'agent.tool.labels.journeyInterview',
        description: '按所选岗位生成自我介绍、至少八条问答与准备清单，每条来源可回指',
        input: z.strictObject({
          docId: z.string().min(1),
          jobId: z.string().min(1),
          platform: z.string().min(1).optional(),
        }),
        effect: 'local-write',
        requiresConfirmation: true,
        run: async ({ docId, jobId, platform }) => {
          const view = await this.interview({ docId, jobId, platform });
          return toolResult(view, {
            summary: `岗位 ${view.jobId} 的面试材料：问答 ${String(view.qa.length)} 条、准备 ${String(view.checklist.length)} 项`,
            evidenceRefs: [`job:${view.platform}/${view.jobId}`],
          });
        },
      }),
    ]);
    this.ctx.logger.info(
      `求职主链就绪：匹配 ${JOURNEY_SEARCH_KIND} · 定制 ${JOURNEY_TAILOR_KIND} · 面试 ${JOURNEY_INTERVIEW_KIND} · ` +
        `节点执行器${registry ? '已登记' : '未登记（工作流未挂载）'} · agent 工具登记 ${String(tools)} 个`,
    );
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    journey: JourneyService;
  }
}
