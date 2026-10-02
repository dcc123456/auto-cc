/**
 * 一张工具卡片：对话流里的工具段与 agent 循环的已落步**共用这一份实现**（AGENTS.md §2.5）。
 *
 * 两处喂进来的数据形状不同（`ChatToolPart` / `AgentStepView`），但画出来的是同一种东西：
 * 名称、参数摘要、状态、耗时、副作用分级，失败时把结构化原因原样显示。
 * 长此以往只留一个卡片组件，卡片上的口径改一次就两边同时生效。
 */
import { Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentStepView, ChatToolPart, ChatToolPartState, ToolDescriptorView } from '@auto-cc/shared';

/** 工具卡片的状态配色；状态本身来自主进程写的那一份读数。 */
export const TOOL_STATE_STYLE: Record<ChatToolPartState, string> = {
  running: 'border-amber-900 bg-amber-950/30 text-amber-200',
  done: 'border-emerald-900 bg-emerald-950/30 text-emerald-300',
  failed: 'border-rose-900 bg-rose-950/40 text-rose-200',
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
  const state: ChatToolPartState = step.status === 'pending' ? 'running' : step.status === 'ok' ? 'done' : 'failed';
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
    errorText: step.code,
  };
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
  const inputLine = (
    <p className="mt-1 break-all text-slate-400" data-tool-input={JSON.stringify(part.input)}>
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
      className={`mt-2 rounded-lg border px-3 py-2 text-[11px] ${TOOL_STATE_STYLE[part.state]}`}
    >
      <div className="flex items-center gap-2">
        <Wrench size={12} />
        <span className="font-medium">{t(labelKey ?? 'agent.tool.unregistered')}</span>
        <span className="font-mono text-slate-500">{part.toolId}</span>
        <span className="ml-auto" data-tool-status={t(`agent.tool.state.${part.state}`)}>
          {t(`agent.tool.state.${part.state}`)}
        </span>
      </div>
      {foldInput ? (
        <details className="mt-1">
          <summary className="cursor-pointer select-none text-slate-400" data-tool-input-toggle>
            {t('agent.tool.inputToggle')}
          </summary>
          {inputLine}
        </details>
      ) : (
        inputLine
      )}
      {/* 观察与证据只在循环卡片上出现（5.2-09 的「指向证据」）：对话卡片没有落步读数，就不画这两段。
          失败那一步的观察同样要画——那是「对话里出现的失败陈述」本体，上面那行裸码只是它的编号。 */}
      {step && step.observation ? (
        <p
          className={`mt-1 break-words ${step.status === 'ok' ? 'text-slate-300' : 'text-rose-200'}`}
          data-step-observation={step.observation}
        >
          {step.observation}
        </p>
      ) : null}
      {step && step.evidenceRefs.length > 0 ? (
        <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-slate-500" data-step-evidence>
          {step.evidenceRefs.map((ref) => (
            <li key={ref} data-evidence-ref={ref} className="break-all">
              {ref}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-1 flex flex-wrap items-center gap-3 text-[10px] text-slate-500">
        {part.durationMs !== null ? (
          <span data-tool-duration={String(part.durationMs)}>{t('agent.tool.duration', { ms: part.durationMs })}</span>
        ) : null}
        {meta ? <span>{t(`agent.tool.effect.${meta.effect}`)}</span> : null}
        {meta?.requiresConfirmation ? <span data-tool-needs-approval>{t('agent.tool.needsConfirm')}</span> : null}
        {part.errorText ? (
          <span className="break-all text-rose-300" data-tool-error={part.errorText}>
            {part.errorText}
          </span>
        ) : null}
      </div>
    </div>
  );
}
