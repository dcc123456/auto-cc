/**
 * agent 循环的计划卡与逐步卡片流（spec 5.2-03 / 04 / 09 / 10）：画在对话流里，不另开一条历史。
 *
 * 整份读数只有两个来源——`agent.loop.read()` 的返回值与 `agent/run-progress` 的推送，
 * 组件自己不数「跑到第几步」、不猜「会不会外发」，那些全是主进程算好的（AGENTS.md §2.5）。
 * `intent` 是模型写的说明文字，按内容显示、不进语言包；界面只负责画它的外壳。
 */
import { Check, ListChecks, Play, Square, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentRunView, ToolDescriptorView } from '@auto-cc/shared';
import { ToolCard, stepToToolPart } from './ToolCard';
import { Banner, DeskButton } from './ui/controls';

/**
 * 计划卡 + 卡片流面板。
 * @param run 当前这条 run 的整份读数（`agent.loop.read` / `agent/run-progress` 那一份）
 * @param toolMetas 注册表读数按 id 建的索引，卡片用它显示副作用分级与标题
 * @param busy 正在执行的动作标签；非空时两个表态按钮都禁用，防止重复触发
 * @param notice 动作提示行（失败原因留在界面上，截图才拿得到证据）
 * @param stopAccepted 已按叫停但 `paused` 还没落进来（此时只能说「已受理」）
 * @param pageHeld 页面此刻是否在人工接管中（`browser.takeover` 那份读数的界面侧）；只用于提示行
 * @param onConfirm 人按下「确认并执行」——确认之前主进程一步都没跑
 * @param onStop 人按下「叫停」
 * @param onResume 人按下「继续」（只出现在被接管按住的那条 run 上，spec 5.5-01）
 * @param onDismiss 收起面板（库里的 run 一行都不动）
 * @returns 一张插在对话流里的面板
 */
export function AgentRunPanel({
  run,
  toolMetas,
  busy,
  notice,
  stopAccepted,
  pageHeld,
  onConfirm,
  onStop,
  onResume,
  onDismiss,
}: {
  run: AgentRunView;
  toolMetas: Map<string, ToolDescriptorView>;
  busy?: string;
  notice?: string;
  stopAccepted: boolean;
  pageHeld: boolean;
  onConfirm: () => void;
  onStop: () => void;
  onResume: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  // 落步按 planStepIndex 索引：计划里的一步有没有对应的卡片，只看这张表，不看内存游标（§2.5）。
  const stepByIndex = new Map(run.steps.map((step) => [step.planStepIndex, step]));
  // 「预计额度消耗」判成「逐步副作用级 + 外发步计数」：额度键的真相在 plugin-entitlement，
  // 镜像一个数字到这里就是第二份事实（plan 5.2-a 的更正）。
  const outboundCount = run.plan.filter((step) => step.effect === 'outbound').length;
  const isProposed = run.status === 'proposed';
  // 「按不动」必须带上原因码：不禁用的按钮与禁用但无说的按钮，对人的欺骗程度一样（07 稿④）。
  const busyReason = busy !== undefined ? 'ACTION_BUSY' : undefined;
  const confirmReason = busyReason ?? (run.plan.length === 0 ? 'EMPTY_PLAN' : undefined);
  const reasonLabel = (code?: string): string | undefined =>
    code === undefined ? undefined : t(`agent.run.reason.${code}`);

  return (
    <li
      data-testid="agent-run-panel"
      data-run-id={run.runId}
      data-run-status={run.status}
      data-run-stop-reason={run.stopReason ?? ''}
      className="rounded-xl border border-line bg-ink-900/60"
    >
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <ListChecks size={14} />
        <h3 className="text-xs font-semibold text-slate-200">{t('agent.run.heading')}</h3>
        {/* 待确认 = 等人表态（琥珀），其余状态是读数（描边）：琥珀不留给"进行中"，那由转针说。 */}
        <span
          data-run-status-label
          className={`rounded-chip border px-2 py-0.5 text-[10px] ${
            isProposed ? 'border-amber/45 bg-amber-wash text-amber' : 'border-line text-slate-400'
          }`}
        >
          {t(`agent.run.status.${run.status}`)}
        </span>
        {/* 收起只是换画法，库里一行都不动，所以它不跟着 busy 禁用（与「叫停」同一口径）。 */}
        <DeskButton action="dismiss-run" variant="ghost" compact className="ml-auto" onClick={onDismiss}>
          <X size={11} />
          {t('agent.run.dismiss')}
        </DeskButton>
      </header>

      <div className="px-3 py-2 text-[11px] text-slate-300">
        <p className="break-words" data-run-goal={run.goal}>
          {t('agent.run.goal', { goal: run.goal })}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-500">
          <span data-run-autonomy={run.autonomy}>
            {t('agent.run.autonomySnapshot', { level: t(`agent.autonomy.${run.autonomy}`) })}
          </span>
          <span data-run-outbound-count={String(outboundCount)}>
            {t('agent.run.outboundCount', { outbound: outboundCount })}
          </span>
          <span data-run-limits>{t('agent.run.limits', { steps: run.stepLimit, tokens: run.tokenBudget })}</span>
          <span data-run-progress={String(run.steps.length)}>
            {t('agent.run.progress', { done: run.steps.length, total: run.plan.length })}
          </span>
          <span data-run-tokens={String(run.tokensUsed)}>{t('agent.run.tokensUsed', { used: run.tokensUsed })}</span>
          {run.stopReason ? (
            <span data-run-stop-reason-label>{t(`agent.run.stopReason.${run.stopReason}`)}</span>
          ) : null}
        </div>
        {/* 档位是「用的时候现问」，所以降档只在下一次判定生效；这一句把 5.2-c 待办①说到人面前。 */}
        {run.status === 'running' ? <p className="mt-1 text-[10px] text-slate-500">{t('agent.run.tierNote')}</p> : null}
        {run.plan.length === 0 ? (
          <p className="mt-1 text-seal" data-run-empty-plan>
            {t('agent.run.emptyPlan')}
          </p>
        ) : null}

        {/* 一步一行：已有落步的画工具卡片（可折叠参数 + 观察 + 证据），还没有落步的画计划条目。 */}
        {run.plan.map((step, index) => {
          const row = stepByIndex.get(step.planStepIndex);
          const meta = toolMetas.get(step.toolId);
          if (!row) {
            return (
              <div
                key={step.planStepIndex}
                data-plan-step={String(index)}
                data-plan-tool-id={step.toolId}
                data-plan-effect={step.effect ?? 'unknown'}
                // 外发步整行描一道朱砂左边线（01 稿第 3 条）：确认之前就该看出哪几步会离开本机。
                className={`mt-2 rounded-md border border-line bg-ink-950/70 px-3 py-2 text-[11px] ${
                  step.effect === 'outbound' ? 'border-l-2 border-l-seal/70' : ''
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-slate-500">{t('agent.run.stepIndex', { index: index + 1 })}</span>
                  <span className="font-medium text-slate-300">{t(meta?.titleKey ?? 'agent.tool.unregistered')}</span>
                  <span className="ml-auto text-slate-500" data-plan-state="pending">
                    {t('agent.run.notStarted')}
                  </span>
                </div>
                <p className="mt-1 break-all font-mono text-[10px] text-slate-500">{step.toolId}</p>
                <p className="mt-1 break-words text-slate-400" data-plan-intent={step.intent}>
                  {step.intent}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-3 text-[10px] text-slate-500">
                  <span>{t(step.effect ? `agent.tool.effect.${step.effect}` : 'agent.run.effectUnregistered')}</span>
                  {step.requiresConfirmation ? (
                    <span data-plan-needs-approval>{t('agent.tool.needsConfirm')}</span>
                  ) : null}
                </div>
              </div>
            );
          }
          return (
            <div key={step.planStepIndex} data-executed-step={String(index)}>
              <div className="mt-2 flex items-center gap-2 text-[10px] text-slate-500">
                <span className="font-mono">{t('agent.run.stepIndex', { index: index + 1 })}</span>
                <span data-plan-intent={step.intent}>{step.intent}</span>
              </div>
              <ToolCard part={stepToToolPart(row, step.input)} meta={meta} foldInput step={row} />
            </div>
          );
        })}
      </div>

      {notice ? (
        <Banner tone="celadon" markers={{ testid: 'agent-run-notice' }} className="mt-2">
          {notice}
        </Banner>
      ) : null}

      <footer className="flex items-center gap-2 border-t border-line px-3 py-2">
        {isProposed ? (
          <>
            {/* 「确认并执行」是让这一步真的动手的那道口：按下去之后循环就可能外发，
                所以它是 `seal` 而不是旧写法的 emerald（emerald 在墨案里是"已经办成"的读数色）。 */}
            <DeskButton
              action="confirm-run"
              variant="seal"
              busy={!!busy}
              disabled={confirmReason !== undefined}
              disabledReason={confirmReason}
              disabledReasonLabel={reasonLabel(confirmReason)}
              onClick={onConfirm}
            >
              <Check size={12} />
              {t('agent.run.confirm')}
            </DeskButton>
            <DeskButton
              action="cancel-run"
              variant="ghost"
              busy={!!busy}
              disabled={busyReason !== undefined}
              disabledReason={busyReason}
              disabledReasonLabel={reasonLabel(busyReason)}
              onClick={onStop}
            >
              <X size={12} />
              {t('agent.run.cancel')}
            </DeskButton>
            {/* 确认前零动作这句话是给**人**看的承诺，也是 5.2-03 的判据本身。 */}
            <span className="ml-auto text-[10px] text-slate-500" data-run-before-confirm>
              {t('agent.run.beforeConfirm')}
            </span>
          </>
        ) : null}
        {run.status === 'running' ? (
          <>
            {/* 叫停**不看 busy**：`loop.confirm` 的回复要等整条循环跑到安全点才回来，
                于是整个 run 期间 busy 一直挂着——若照上面两个按钮的写法禁用，
                用户唯一需要按的那一颗恰好在他唯一需要按的时候按不到（5.2-c 实测：两次点停都落在禁用态上）。
                主进程侧 `stop()` 对任何状态都不抛错（终态原样返回读数），重复按也只是再置一次信号。 */}
            <DeskButton action="stop-run" variant="amber" onClick={onStop}>
              <Square size={12} />
              {t('agent.run.stopNow')}
            </DeskButton>
            {stopAccepted ? (
              <span className="text-[10px] text-amber" data-run-stop-accepted>
                {t('agent.run.stopAccepted')}
              </span>
            ) : (
              <span className="ml-auto text-[10px] text-slate-500">{t('agent.run.stopHint')}</span>
            )}
          </>
        ) : null}
        {/* 被接管按住的那条 run 才有第三颗按钮（spec 5.5-01 的第二个动作）：
            「交还页面」把操作权还给 agent，这一颗才是「接着跑」——两次分开表态，
            因为人可以只改个登录态、看一眼，再决定要不要让它继续。
            页面仍在接管时**不禁用**它：主进程会用 `AGENT_LOOP_TAKEOVER_HELD` 结构化拒绝，
            那句原话落在下面的提示行里。把拒绝藏起来，界面上就只剩一个按了没反应的按钮（§2.6）。 */}
        {run.status === 'paused' && run.stopReason === 'TAKEOVER_HELD' ? (
          <>
            <DeskButton
              action="resume-run"
              variant="amber"
              busy={!!busy}
              disabled={busyReason !== undefined}
              disabledReason={busyReason}
              disabledReasonLabel={reasonLabel(busyReason)}
              onClick={onResume}
            >
              <Play size={12} />
              {t('agent.run.resume')}
            </DeskButton>
            <span className="ml-auto text-[10px] text-slate-500" data-run-resume-hint={pageHeld ? 'held' : 'free'}>
              {t(pageHeld ? 'agent.run.resumeHeldHint' : 'agent.run.resumeHint')}
            </span>
          </>
        ) : null}
      </footer>
    </li>
  );
}
