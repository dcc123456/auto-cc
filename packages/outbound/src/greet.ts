/**
 * `outbound.greet` 服务（spec 2.5-02 / 03 / 04 / 09 / 10 / 13）：打招呼的唯一编排入口。
 *
 * 顺序是硬的，每一步都有对应的验收条目，不能换也不能省：
 * 风险确认（该平台签过字吗，spec 2.7-06）→ 渠道 →
 * 幂等（同 run 同 target 不重发）→ 内容（现成文案或 `outbound.script` 生成）→ 黑名单 →
 * 额度**先查后等**（到量即停，不该白等一个频控间隔）→ 频控（以账本最近一条为钟）→
 * `gate.perform`（判定→执行→落账）→ 页面回读说「没发出去」时抛错，**不落账**。
 *
 * 它不认识任何平台，也**不保存任何平台的手**：每次要发送时按名字向 `platform.registry` 现问
 * 一条渠道（`GreetChannelSource`，契约在 `@auto-cc/core`）。早先这里是平台包反向登记进来的一张表，
 * 那是把适配器这一份事实存了两处 —— 实测上游改一次配置就会重建本服务、那张表当场清空，
 * 打招呼从此静默失败到重启为止（plan §12.13）。问一次不贵，养一份状态才贵。
 * 契约留在 core 是因为让本包 import `@auto-cc/plugin-browser` 会新开一条 L2 横向依赖
 * （AGENTS.md §4.1，plan §12.12 第 1 条）。
 */
import {
  AppError,
  asApp,
  assertNotYielded,
  consentGateOf,
  executorRegistryOf,
  greetChannelsOf,
  Service,
  sleep,
  type WorkflowNodeExecutor,
  type Context,
  agentTool,
  registerAgentTools,
} from '@auto-cc/core';
import type { GreetReceiptView, GreetRequestView } from '@auto-cc/shared';
import { z } from 'zod';
import { SCRIPT_KINDS, scriptRequestSchema } from './script.js';

/** 额度键与账本动作名（`entitlement.gate` 按它数日上限，spec 2.5-02 / 2.5-04）。 */
export const GREET_ACTION = 'greet';

/** 工作流节点名（spec 2.5-e：`greeting.send`）；与 `jd.capture` 同一命名口径，计划里按它选执行器。 */
export const GREET_NODE_KIND = 'greeting.send';

/** 编排层暂无可选项；strict 让 `cordis.yml` 里写错的键在挂载期就报错。 */
export const greetSchema = z.strictObject({});

/** 校验后的配置形状（调用点与测试引用它，而不是手写一遍 zod 推断）。 */
export type GreetConfig = z.infer<typeof greetSchema>;

/**
 * 打招呼请求的入站校验（渲染层与计划都是不可信来源，AGENTS.md §2.6）。
 *
 * `text` 与 `script` 二选一：前者是用户在界面上改过的现成文案，后者交给 `outbound.script` 生成。
 * `provenance` 只在 `text` 那一路有意义：界面上"选中一条候选再发送"的内容是现成的，
 * 但它的来源（版本 / 类型 / 引用的经历）不该就此丢掉（spec 4.6-02 与 M4 的"留生成来源"）。
 * `nowMs` 是判定与落账的基准，单测靠它造「刚发过一次」而不必真等 45 秒。
 */
const greetRequestSchema = z.strictObject({
  platform: z.string().min(1),
  jobId: z.string().min(1),
  text: z.string().min(1).optional(),
  script: scriptRequestSchema.optional(),
  provenance: z
    .strictObject({
      jdId: z.string().min(1),
      kind: z.enum(SCRIPT_KINDS),
      scriptVersion: z.string().min(1),
      evidenceRefs: z.array(z.string().min(1)),
    })
    .optional(),
  workflowRunId: z.string().min(1).nullish(),
  nowMs: z.number().int().positive().optional(),
});

/**
 * 拼账本 `source` 列那条可追溯链（spec 2.5-09 + 4.6-02）。
 *
 * 两条腿共用一个拼装函数：格式长两遍就是两条复盘口径。`manualPrefix` 为真时链首是 `manual`，
 * 表示"这条正文是调用方给定的、本服务没有再生成"，其后仍是生成它的那份话术的来源。
 * @param manualPrefix 内容是否来自调用方的现成文案
 * @param scriptVersion 提示词与模板的版本号（注册表常量）
 * @param kind 话术分型（4.6-01）
 * @param jdId 归属的 JD 标识
 * @param evidenceRefs 这条话术引用的知识库证据 id，可为空（未引用经历）
 * @returns 形如 `script-v1:greeting:1002#kb-abc` 的来源串；无引用时不带 `#` 段
 */
function ledgerSource(
  manualPrefix: boolean,
  scriptVersion: string,
  kind: string,
  jdId: string,
  evidenceRefs: readonly string[],
): string {
  const chain = manualPrefix ? ['manual', scriptVersion, kind, jdId] : [scriptVersion, kind, jdId];
  return evidenceRefs.length > 0 ? `${chain.join(':')}#${evidenceRefs.join(',')}` : chain.join(':');
}

/**
 * 把节点参数里的字符串读出来（缺键或非字符串都返回 null，由调用方报缺参数）。
 * @param value `spec.params` 里的原始值（声明值类型是 string/number/boolean）
 * @returns 非空字符串本身，否则 null
 */
function paramString(value: string | number | boolean | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export class OutboundGreetService extends Service {
  static provide = 'outbound.greet';
  static Config = greetSchema;
  // 闸门与账本来自 `entitlement`，话术与频控是同包的兄弟服务：本服务自己不碰网络、不碰 DOM。
  // `platform.registry` 是硬依赖（同 `conversation.store` 的先例）：没有平台层就没有任何发送的手，
  // 此时本服务留在 PENDING，界面上的外发口得到结构化错误，而不是「点了没反应」。
  static inject = [
    'entitlement.gate',
    'usage.ledger',
    'outbound.script',
    'outbound.throttle',
    'platform.registry',
    // 首次风险确认的判据（spec 2.7-06）：硬依赖，理由见 `consentGateOf`——读不到签字就是没签过。
    'sessions',
  ];

  constructor(ctx: Context, _options: GreetConfig) {
    // 无配置项也要接住第二个实参：cordis 递的是校验后的配置对象（AGENTS.md §9 实测 1.3）。
    super(ctx, 'outbound.greet');
  }

  /**
   * 打一次招呼：走完上面那条顺序，成功才落账。
   * @param raw 请求（见 `greetRequestSchema`）；平台、目标、文案/生成入参
   * @param signal 让出信号，工作流节点路径用它响应暂停；界面路径传 undefined
   * @returns 回执（账本行 id、实际等待时长、来源标识、内容来源）
   * @throws `INVALID_ARGUMENT`（入参不合法或文案与生成入参都缺）、`CONSENT_REQUIRED`（该平台还没签过风险确认，
   *         此时一个页面都不碰、一次话术都不生成）、`OUTBOUND_CHANNEL_MISSING`、
   *         `OUTBOUND_ALREADY_SENT`（同 run 同 target 重发）、`OUTBOUND_FORBIDDEN_CONTENT`（黑名单/超长）、
   *         `QUOTA_EXCEEDED`（日额度到量）、`OUTBOUND_NOT_DELIVERED`（页面回读说没发出去，此时不落账）、
   *         `WORKFLOW_STEP_FAILED`（频控等待期间工作流让出，此时既不发送也不落账）
   */
  perform = async (raw: unknown, signal?: AbortSignal): Promise<GreetReceiptView> => {
    const parsed = greetRequestSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `打招呼请求不合法：${parsed.error.issues[0]?.message ?? ''}`,
        'outbound.greet',
      );
    }
    const { platform, jobId, text, script, provenance, workflowRunId } = parsed.data;
    const nowMs = parsed.data.nowMs ?? Date.now();
    const runId = workflowRunId ?? null;

    // 风险确认问在**最前面**（早于渠道、早于话术生成）：没签过字就不该花一次 LLM、更不该碰页面（spec 2.7-06）。
    // 界面那条确认卡片只是第一道，工作流节点与 agent 工具这两条入口都从这里出去，漏了就是静默绕过。
    consentGateOf(this.ctx).ensureConsent(platform);

    // 渠道放在第一步问（不是发送前才问）：平台名写错时要在**花钱生成话术之前**就失败，
    // 而不是等 LLM 写完一段发不出去的文案。现问现取，所以本服务不持有任何平台状态。
    const sources = greetChannelsOf(this.ctx);
    const channel = sources?.greetChannel(platform) ?? null;
    if (!channel) {
      throw new AppError('OUTBOUND_CHANNEL_MISSING', `平台 ${platform} 现在没有可用的打招呼渠道`, 'outbound.greet', {
        platform,
        greetable: sources?.greetablePlatforms() ?? [],
      });
    }

    // 重复发送防护 = 幂等键 + 账本按 target 计数（spec 2.5-13）：内存里没有「已发送集合」，
    // 所以重启后依然成立，而判据就是「这条 (action, target, run) 有没有落成过一行」。
    const ledger = asApp(this.ctx)['usage.ledger'];
    if (ledger.countFor(GREET_ACTION, jobId, runId) > 0) {
      throw new AppError(
        'OUTBOUND_ALREADY_SENT',
        `目标 ${jobId} 在本次运行里已经打过招呼，不再重复发送`,
        'outbound.greet',
        {
          jobId,
          workflowRunId: runId,
        },
      );
    }

    const scriptService = asApp(this.ctx)['outbound.script'];
    let finalText: string;
    let origin: GreetReceiptView['origin'];
    let source: string;
    if (text) {
      // 界面上改过的文案：正文是现成的，但选中候选那条链不能断（spec 4.6-02）——
      // 调用方把候选的来源随 `provenance` 一起递过来，账本里就能写出「manual + 哪个版本给哪条 JD 生成的」。
      // 没带 provenance 时（工作流节点、agent 工具那种纯手打文案）来源如实写成 manual。
      finalText = text;
      origin = 'manual';
      source = provenance
        ? ledgerSource(true, provenance.scriptVersion, provenance.kind, provenance.jdId, provenance.evidenceRefs)
        : `manual:${script?.jdId ?? jobId}`;
    } else {
      if (!script) {
        throw new AppError(
          'INVALID_ARGUMENT',
          `打招呼要么带现成文案，要么带话术生成入参（岗位名与公司名缺一不可），目标 ${jobId} 两者都没给`,
          'outbound.greet',
        );
      }
      const draft = await scriptService.generate(script);
      finalText = draft.text;
      origin = draft.origin;
      // 2.5-09 的可追溯来源：模板版本 + 话术类型 + JD id（+ 证据引用），写进账本已有的 `source`
      // 列（不加列、不加迁移）。字段取自 draft 本身，不信调用方递的 provenance——现生成的那条就是真相源。
      source = ledgerSource(false, draft.scriptVersion, draft.kind, draft.jdId, draft.evidenceRefs);
    }
    // 文本离开 app 的边界就在这里（spec 2.5-10）：模型产出、模板回落、用户手改三路都过同一份黑名单。
    scriptService.assertSendable(finalText, origin);

    const gate = asApp(this.ctx)['entitlement.gate'];
    // 先查额度再等间隔：到量即停的意思就是「别让用户白等一个频控周期」（spec 2.5-04）。
    const decision = gate.check(GREET_ACTION, { nowMs });
    if (!decision.allowed) {
      throw new AppError('QUOTA_EXCEEDED', decision.reason ?? `动作 ${GREET_ACTION} 的额度已用完`, 'outbound.greet', {
        action: GREET_ACTION,
        remaining: decision.remaining,
      });
    }

    // 频控的钟是账本里最近一条 greet，不是本服务的内存字段：跨重启成立，也不是第二套状态存储（§2.7）。
    const gap = asApp(this.ctx)['outbound.throttle'].nextGapMs();
    const lastSentAt = ledger.latestActionTs(GREET_ACTION);
    let waitedMs = 0;
    if (lastSentAt !== null) {
      const remaining = lastSentAt + gap - nowMs;
      if (remaining > 0) {
        await sleep(remaining, signal);
        waitedMs = remaining;
      }
    }
    // 让出检查点必须落在**发送之前**：`sleep` 在 abort 时是正常返回的（暂停不是失败），
    // 不在这里问一句，被暂停的那一步仍会把消息发出去（spec 2.4-07）。
    assertNotYielded(signal, 'outbound.greet', '打招呼');

    const { value, ledgerId } = await gate.perform(
      GREET_ACTION,
      { targetId: jobId, workflowRunId: runId, nowMs: nowMs + waitedMs, source },
      async () => {
        const outcome = await channel.send(jobId, finalText);
        // 页面没确认发送成功就不该有账：闸门只在 task 成功后落账，抛在这里正好复用那条性质。
        if (!outcome.sent) {
          throw new AppError('OUTBOUND_NOT_DELIVERED', outcome.reason, 'outbound.greet', { jobId });
        }
        return outcome.reason;
      },
    );
    this.ctx.logger.info(
      `打招呼已发出并落账：目标 ${jobId} · 等待 ${String(waitedMs)}ms · 来源 ${source} · 账本行 ${String(ledgerId)}`,
    );
    return { platform, jobId, reason: value, ledgerId, waitedMs, source, origin };
  };

  /**
   * 作为工作流节点（`kind: greeting.send`）时的执行函数，登记进 `workflow.executors` 的就是这只手。
   *
   * 参数名按**计划的口径**读：`platform`/`job` 定位目标，`text` 是现成文案，
   * 没给 `text` 时用 `title`/`company` 生成（spec 2.4 的节点参数只允许声明值，所以关键词列表不进参数）。
   * 公开而不是 private：界面路径与工作流路径要在单测里对照同一份编排，藏起来就只能靠假登记处间接触达。
   * @param invocation 节点执行输入：`runId` 参与幂等键，参数从 `spec.params` 来，让出信号从 `signal` 来
   * @throws 缺 `platform` 或 `job` 时 `INVALID_ARGUMENT`；其余失败语义同 `perform`
   */
  executeNode: WorkflowNodeExecutor = async ({ runId, spec, signal }) => {
    const platform = paramString(spec.params.platform);
    const jobId = paramString(spec.params.job);
    if (!platform || !jobId) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `节点 ${spec.id} 缺少参数${!platform ? ' platform' : ''}${!jobId ? ' job' : ''}，不知道要跟谁打招呼`,
        GREET_NODE_KIND,
        { nodeId: spec.id },
      );
    }
    const title = paramString(spec.params.title);
    const company = paramString(spec.params.company);
    const request: GreetRequestView = {
      platform,
      jobId,
      workflowRunId: runId,
      text: paramString(spec.params.text) ?? undefined,
      script: title && company ? { jdId: jobId, title, company } : undefined,
    };
    await this.perform(request, signal);
  };

  [Service.init](): void {
    // 登记处是可选依赖：工作流没装时打招呼照样能从界面单次触发，只是没有节点可跑。
    const registry = executorRegistryOf(this.ctx);
    if (registry) {
      registry.register(GREET_NODE_KIND, this.executeNode);
      // 卸载时摘回登记：留下指向已销毁实例的函数，下一次跑工作流会得到无法解释的错误。
      this.ctx.effect(() => () => registry.unregister(GREET_NODE_KIND));
    }
    // 这一句读数每次挂载都重新问一遍 `platform.registry`：改配置重建本服务时，这里就是证据——
    // 早先它读的是自己那张被重建清空的表，于是「已登记渠道（暂无）」骗过了装配面板（plan §12.13）。
    // 打招呼的 consent 硬拦与额度闸门都在 `perform` 内部（`greet.ts:116` / `:170`），工具层只转发：
    // 两处判据是同一处判据，工具面因此不可能成为绕过 `entitlement.gate` 的后门（plan §15.7 落点 5）。
    // 入参只收 `text` 这条现成文案：话术生成（`script`）属知识库轨（P3），不在这里欠账。
    const tools = registerAgentTools(this.ctx, [
      agentTool({
        id: 'outbound.greet.perform',
        titleKey: 'agent.tool.labels.greetPerform',
        description: '向指定岗位的目标发送一句打招呼文案，经闸门判定并落一条 greet 账',
        input: z.strictObject({
          request: z.strictObject({
            platform: z.string().min(1),
            jobId: z.string().min(1),
            text: z.string().min(1),
          }),
        }),
        effect: 'outbound',
        requiresConfirmation: true,
        run: ({ request }) => this.perform(request),
      }),
    ]);
    const greetable = greetChannelsOf(this.ctx)?.greetablePlatforms() ?? [];
    this.ctx.logger.info(
      `打招呼编排就绪：额度键 ${GREET_ACTION} · 当前可打招呼平台 ${greetable.join(' / ') || '（平台层尚未登记带 chat 的适配器）'} · 节点执行器${registry ? `已登记 ${GREET_NODE_KIND}` : '未登记（工作流未挂载）'} · agent 工具登记 ${String(tools)} 个${tools === 0 ? '（注册表未挂载）' : ''}`,
    );
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'outbound.greet': OutboundGreetService;
  }
}
