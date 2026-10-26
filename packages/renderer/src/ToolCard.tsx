/**
 * 一张工具卡片：对话流里的工具段与 agent 循环的已落步**共用这一份实现**（AGENTS.md §2.5）。
 *
 * 两处喂进来的数据形状不同（`ChatToolPart` / `AgentStepView`），但画出来的是同一种东西：
 * 名称、参数摘要、状态、耗时、副作用分级，失败时把结构化原因原样显示。
 * 长此以往只留一个卡片组件，卡片上的口径改一次就两边同时生效。
 */
import { Briefcase, ChevronDown, ChevronRight, LoaderCircle, Wrench } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AgentStepView,
  ChatToolPart,
  ChatToolPartState,
  JobListResultView,
  ToolDescriptorView,
} from '@auto-cc/shared';
import { DeskButton, EffectChip } from './ui/controls';
import { EvidenceRefButton } from './EvidenceRefButton';
import { JobResultCards } from './JobResultCards';
import { useBridgeAction } from './useBridgeAction';

/**
 * 工具步的三处分色（左侧状态轨 / 前置图标 / 状态字样）：**一张表按 `ChatToolPartState` 给齐**。
 *
 * 2026-10-19 设计稿 v2：卡片外框整个退掉，一条 1px 左侧状态轨说"这一步此刻在哪个档"（参考图那一行就是
 * 方角图标 + 一句灰字，没有卡片）。分色只出自这一张表，轨色与字样必然同步改（原先 `frame` 与 `chip`
 * 同表声明是同一条纪律的前身）。
 * 四态全部走本仓语义令牌，不用 Tailwind 默认的 emerald/rose/amber 三原色：默认色阶不在设计系统口径里
 * （浅色主题下不跟着翻面），而且它们把"进行中"画成琥珀色，与「等人表态」撞色——进行中是青瓷，
 * 琥珀只说"这台机器在等你"。跳过用中性偏冷：既不提示"正在跑"，也不把"人做完了"染成失败或系统的功劳（5.5-08）。
 */
const TOOL_STATE_CLASS: Record<ChatToolPartState, { rail: string; lead: string; state: string }> = {
  running: { rail: 'border-celadon', lead: 'text-celadon', state: 'text-celadon' },
  done: { rail: 'border-jade', lead: 'text-slate-400', state: 'text-jade' },
  failed: { rail: 'border-seal', lead: 'text-slate-400', state: 'text-seal-ink' },
  skipped: { rail: 'border-line-strong', lead: 'text-slate-400', state: 'text-slate-400' },
};

/**
 * 把 agent 循环的一步映射成卡片读数（spec 5.2-04）。
 *
 * 循环的落步与对话的工具段是两套语言（`ok` / `done`、`code` / `errorText`），
 * 但界面只该有一套卡片：这里做一次翻译，卡片本体不需要知道步是谁写的。
 * 失败那一步的陈述用 `code` 开头，后面接观察原文——**不改口成「已完成」**（5.2-09）。
 * @param step `AgentRunView.steps` 里的一条
 * @param input 计划里同下标那一步的入参（步行只存 toolId 与结果，入参在 `plan` 那一侧）
 * @returns 直接喂给 `ToolCard` 的工具段
 */
export function stepToToolPart(step: AgentStepView, input: unknown): ChatToolPart {
  const state: ChatToolPartState =
    step.status === 'pending'
      ? 'running'
      : step.status === 'ok'
        ? 'done'
        : step.status === 'skipped'
          ? 'skipped'
          : 'failed';
  return {
    kind: 'tool',
    // 卡片键位带上 run 与下标：同一条链里两步调同一只工具时，React 不能把它们认成一张卡。
    toolCallId: `${step.runId}/step/${String(step.planStepIndex)}`,
    toolId: step.toolId,
    input,
    state,
    // `output` 装的是工具交回的结构化读数，落步存的是「给模型的那句摘要」，两者不是一回事；
    // 摘要由 `step` 那一props 画出来，这里留 null 而不是把摘要塞进一个它不属于的字段。
    output: null,
    durationMs: step.durationMs,
    // 失败码原样带出（是数据不是文案，不进语言包），中文陈述由观察那一行负责。
    // 跳过那一格例外：它的 `code` 是 `DONE_BY_HUMAN`，记的是"谁做的"而不是"哪里错了"，
    // 摆进红色那格就成了报错；原话已经在观察那一行说给人在看，错误位留空。
    errorText: step.status === 'skipped' ? null : step.code,
  };
}

/** 展开岗位卡时向库里要多少行：够扫一屏，又不至于把一段对话撑成整张表。 */
const JOB_CARD_LIMIT = 20;

/** `jd.capture.run` 的结果里最多带多少条岗位证据引用（`jd-capture.ts` 的 `CAPTURED_REF_LIMIT`）。 */
const JOB_REF_CAP = 12;

/**
 * 这张卡片能指到几条岗位。
 *
 * 两处喂进来的数据不同：对话工具段带得到 `ToolResult.value`（`CaptureRunView.captured`，最准），
 * 而循环的落步只留了证据引用——那条路上回收的岗位键被工具侧钳到 12 条，所以当它顶到钳位时
 * 只能给出「至少这么多」（卡片上写 `N+`），不把 12 冒充成 13 条结果。
 * @param part 工具段
 * @param step 循环落步（只有循环卡片带）
 * @returns 条数与「是否顶到钳位」；不是抓取结果或一条都没抓到时为 null（没有可看的岗位就不长按钮）
 */
function jobCountOf(part: ChatToolPart, step?: AgentStepView): { count: number; capped: boolean } | null {
  const value = part.output?.value;
  if (typeof value === 'object' && value !== null) {
    const captured = (value as { captured?: unknown }).captured;
    if (Array.isArray(captured)) return captured.length === 0 ? null : { count: captured.length, capped: false };
  }
  if (!step) return null;
  const count = step.evidenceRefs.filter((ref) => ref.startsWith('job:')).length;
  return count === 0 ? null : { count, capped: count >= JOB_REF_CAP };
}

/**
 * 一张工具调用卡片（spec 2.8-09：工具名、关键参数、状态、耗时，外加副作用分级）。
 *
 * 卡片是**一条消息的一部分**，不是另一条消息：agent 一次输出「文本 + 工具调用」时不需要改表。
 * @param part 主进程写进 `parts[]`（或由 `stepToToolPart` 从落步映射来）的工具段
 * @param meta 注册表里这只工具的声明（`agent.tools.list()` 的读数）；未登记或读数未回来时为 undefined
 * @param foldInput 参数摘要收成可折叠（spec 5.2-04 要的「可折叠工具卡片」）；对话里的卡片保持平铺
 * @param step 这一步的落库读数（只有循环卡片带）：观察与证据引用从这里画，对话卡片传 undefined 就少这两段
 * @returns 标题 + 入参摘要 + 状态 + 分级；失败时把结构化原因原样显示，不改口成「已完成」
 */
export function ToolCard({
  part,
  meta,
  foldInput = false,
  step,
}: {
  part: ChatToolPart;
  meta?: ToolDescriptorView;
  foldInput?: boolean;
  step?: AgentStepView;
}) {
  const { t } = useTranslation();
  // 标题键来自注册表声明本身（spec 5.1-02：一份事实一个来源），界面不再留 id→键的映射表；
  // 未登记或读数未回来时只有这一条兜底文案，卡片因此永远不会显示裸 id 当标题。
  const labelKey = meta?.titleKey;
  const stateClass = TOOL_STATE_CLASS[part.state];
  const stateLabel = t(`agent.tool.state.${part.state}`);
  // 抓取卡的结果展开（spec 8.10-04）：只有「本轮真抓到过岗位」的卡片才长这颗键；
  // 行数据展开时才向 `jd.store.list` 现读，渲染层不缓存一份「我以为抓到了什么」。
  const jobCount = part.toolId === 'jd.capture.run' && part.state === 'done' ? jobCountOf(part, step) : null;
  const [jobsOpen, setJobsOpen] = useState(false);
  const [jobs, setJobs] = useState<JobListResultView>();
  /** 这张卡没有「动作跑完重读快照」这回事：展开读的是一次性读数，复用外壳只为忙碌态与失败提示同一套呈现。 */
  const nothingToReread = useCallback(() => Promise.resolve(), []);
  const {
    busy: jobsBusy,
    notice: jobsNotice,
    noticeTone: jobsNoticeTone,
    run: readJobs,
  } = useBridgeAction(nothingToReread);
  const toggleJobs = (): void => {
    const next = !jobsOpen;
    setJobsOpen(next);
    if (next && jobs === undefined) {
      void readJobs(t('agent.tool.jobs.actionRead'), () => window.autoCC?.jd['store.list'](JOB_CARD_LIMIT), {
        apply: setJobs,
      });
    }
  };
  const inputLine = (
    <p
      className="w-full break-all pl-5 font-mono text-[11.5px] leading-[1.6] text-slate-400"
      data-tool-input={JSON.stringify(part.input)}
    >
      {t('agent.tool.input', { input: JSON.stringify(part.input) })}
    </p>
  );
  return (
    <div
      data-testid="chat-tool-card"
      data-tool-id={part.toolId}
      data-tool-state={part.state}
      data-tool-effect={meta?.effect ?? 'unknown'}
      data-tool-confirm={meta ? String(meta.requiresConfirmation) : 'unknown'}
      className={`ml-2.5 flex flex-wrap items-baseline gap-x-2 border-l py-1 pl-[11px] text-[12.5px] leading-[1.6] text-slate-300 ${stateClass.rail}`}
    >
      {/* 进行中那一格用转圈而不是扳手——扳手说的是"调过这只工具"，转圈说的是"现在还在调"（spec 2.8-09）。
          工具名与 id 都给：`titleKey` 是人话，裸 id 才是活体读数要对的那一串字符。 */}
      <span className={`inline-flex items-center ${stateClass.lead}`} aria-hidden="true">
        {part.state === 'running' ? <LoaderCircle size={13} className="animate-spin" /> : <Wrench size={13} />}
      </span>
      <span className="text-slate-100">{t(labelKey ?? 'agent.tool.unregistered')}</span>
      <span className="font-mono text-[11.5px] text-slate-400">{part.toolId}</span>
      <span
        className={`font-mono text-[11px] font-medium tracking-[0.06em] ${stateClass.state}`}
        data-tool-status={stateLabel}
      >
        {stateLabel}
      </span>
      {part.durationMs !== null ? (
        <span className="font-mono text-[11px] text-slate-400" data-tool-duration={String(part.durationMs)}>
          {t('agent.tool.duration', { ms: part.durationMs })}
        </span>
      ) : null}
      {meta ? <EffectChip effect={meta.effect}>{t(`agent.tool.effect.${meta.effect}`)}</EffectChip> : null}
      {meta?.requiresConfirmation ? (
        <span className="text-[11px] text-slate-400" data-tool-needs-approval>
          {t('agent.tool.needsConfirm')}
        </span>
      ) : null}
      {/* 失败码原样带出（是数据不是文案，不进语言包），中文陈述由观察那一行负责。 */}
      {part.errorText ? (
        <span className="break-all font-mono text-[11px] text-seal" data-tool-error={part.errorText}>
          {part.errorText}
        </span>
      ) : null}
      {foldInput ? (
        <details className="w-full">
          <summary className="cursor-pointer select-none text-[11.5px] text-slate-400" data-tool-input-toggle>
            {t('agent.tool.inputToggle')}
          </summary>
          {inputLine}
        </details>
      ) : (
        inputLine
      )}
      {/* 观察与证据只在循环卡片上出现（5.2-09 的「指向证据」）：对话卡片没有落步读数，就不画这两段。
          失败那一步的观察同样要画——那是「对话里出现的失败陈述」本体，上面那行裸码只是它的编号。
          跳过那一格与成功同色：它说的是一句已成的事实（人做完了），不是一处需要修的错（5.5-08）。 */}
      {step && step.observation ? (
        <p
          className={`w-full break-words ${step.status === 'failed' || step.status === 'refused' ? 'text-seal' : 'text-slate-300'}`}
          data-step-observation={step.observation}
        >
          {step.observation}
        </p>
      ) : null}
      {/* 5.7-02：引用从裸文本变成点得开的读数。run 与步下标从这里带进去（只有循环卡片有 `step`），
          分派前缀的事一概交给主进程那一只手，界面不知道 `ledger:` 归账本、`doc:` 归简历。 */}
      {step && step.evidenceRefs.length > 0 ? (
        <ul className="mt-1 flex w-full flex-col gap-y-1 font-mono text-[10px] text-slate-500" data-step-evidence>
          {step.evidenceRefs.map((ref) => (
            <EvidenceRefButton key={ref} runId={step.runId} planStepIndex={step.planStepIndex} evidenceRef={ref} />
          ))}
        </ul>
      ) : null}
      {/* 抓完一批之后的结果得有人能扫（spec 8.10-04）：主进程那三键契约不改，界面自己多一颗展开口，
          展开时现读库里的真行。`N+` 只出现在循环卡片上——那条路只留得住 12 条岗位引用（`jobCountOf`）。 */}
      {jobCount !== null ? (
        <div className="w-full">
          <DeskButton
            action="review-job-cards"
            variant="line"
            compact
            busy={jobsBusy !== undefined}
            markers={{ 'job-count': String(jobCount.count) }}
            onClick={toggleJobs}
          >
            {jobsOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            <Briefcase size={11} />
            {t(jobCount.capped ? 'agent.tool.jobs.openCapped' : 'agent.tool.jobs.open', { count: jobCount.count })}
          </DeskButton>
          {jobsOpen ? (
            <div className="mt-1 w-full">
              {jobsBusy !== undefined ? (
                <p className="text-[11px] text-celadon" data-testid="job-result-loading">
                  {t('agent.tool.jobs.loading')}
                </p>
              ) : null}
              {jobsBusy === undefined && jobs === undefined && jobsNotice ? (
                <p
                  className={`break-words text-[11px] ${jobsNoticeTone === 'seal' ? 'text-seal' : 'text-amber'}`}
                  data-testid="job-result-error"
                >
                  {jobsNotice}
                </p>
              ) : null}
              {jobs ? <JobResultCards result={jobs} /> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
