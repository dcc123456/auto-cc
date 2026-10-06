/**
 * 免确认白名单面板（spec 5.3-06 / 07）：挂在档位行下面，让「哪些动作已经免确认」在界面上读得出来。
 *
 * 面板自己不判「这只手要不要确认」：名单来自 `agent.policy.exemptList`，副作用级与批准声明来自
 * `agent.tools.list` 那份注册表读数，两处都是主进程算好的（AGENTS.md §2.5）。
 * 可加白的候选因此只有一个来源——注册表里**自己声明要人批准**的那些；`semi` 档不看名单，
 * 所以这一片在非 `auto` 档只是「看得见的设置」，不是当下的行为差异。
 */
import { ShieldCheck, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AutonomyLevel, ExemptToolView, ToolDescriptorView } from '@auto-cc/shared';
import { ArmButton, DeskButton, EffectChip } from './ui/controls';
import { useBridgeAction } from './useBridgeAction';

/**
 * 把加白时刻画成一行本地时间。
 * @param at 毫秒时间戳（主进程 `Date.now()` 落库的那一位）
 * @returns 本地化日期时间串（不是文案：不含需要翻译的词）
 */
function formatAddedAt(at: number): string {
  return new Date(at).toLocaleString();
}

/**
 * 白名单面板：已免确认清单（逐条可撤销）+ 可加白清单（逐条可加白）。
 * @param tools 注册表读数（`agent.tools.list` 那一份），用来筛候选与显示副作用级
 * @param autonomy 当前档位；非 `auto` 时在面板上说明「名单暂不影响执行」
 * @returns 一条贴在档位行下方的设置带
 */
export function AgentPolicyPanel({
  tools,
  autonomy,
}: {
  tools: ToolDescriptorView[];
  autonomy: AutonomyLevel | undefined;
}) {
  const { t } = useTranslation();
  const [exempt, setExempt] = useState<ExemptToolView[]>();
  const bridge = window.autoCC;

  /** 重读名单：动作跑完一律回库里读，界面不拿返回值自己拼下一份状态。 */
  const read = useCallback(async () => {
    const reply = await bridge?.agent['policy.exemptList']();
    if (reply?.ok) setExempt(reply.value);
  }, [bridge]);

  useEffect(() => {
    void read();
  }, [read]);

  const { busy, notice, run: call } = useBridgeAction(read);
  const exemptIds = new Set((exempt ?? []).map((row) => row.toolId));
  const candidates = tools.filter((tool) => tool.requiresConfirmation && !exemptIds.has(tool.id));
  const busyReason = busy !== undefined ? 'ACTION_BUSY' : undefined;
  const busyLabel = busyReason === undefined ? undefined : t('agent.policy.reason.ACTION_BUSY');

  // 整带限高且自带滚动：窗口矮时这一带让位给消息流，而不是把任务卡挤出可视区（5.7-d 实测过
  // 737px 高的窗口里它长到 191px，消息流被挤成 24px 的一条缝）。带内两张清单仍各自限高。
  return (
    <div
      data-testid="agent-policy-panel"
      className="max-h-20 min-h-[56px] shrink overflow-y-auto border-b border-line px-4 py-2"
    >
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1 text-[10px] text-slate-500">
          <ShieldCheck size={11} />
          {t('agent.policy.heading')}
        </span>
        <span className="text-[10px] text-slate-400" data-exempt-count={String(exempt?.length ?? 0)}>
          {t('agent.policy.exemptCount', { total: exempt?.length ?? 0 })}
        </span>
        {autonomy !== undefined && autonomy !== 'auto' ? (
          <span className="text-[10px] text-amber" data-policy-tier-note>
            {t('agent.policy.onlyAuto', { level: t(`agent.autonomy.${autonomy}`) })}
          </span>
        ) : null}
      </div>
      {/* 这一句是给**人**看的边界：免确认只免掉「每次都问」，额度闸门与频控不在它手里（AGENTS.md §7.3）。 */}
      <p className="mt-1 text-[10px] text-slate-500">{t('agent.policy.hint')}</p>

      {exempt === undefined ? (
        <p className="mt-1 text-[11px] text-slate-500" data-testid="agent-policy-loading">
          {t('agent.policy.loading')}
        </p>
      ) : exempt.length === 0 ? (
        <p className="mt-1 text-[11px] text-slate-500" data-testid="agent-policy-empty">
          {t('agent.policy.empty')}
        </p>
      ) : (
        <ul data-testid="agent-policy-exempt" className="mt-2 max-h-28 space-y-1 overflow-y-auto">
          {exempt.map((row) => (
            <li
              key={row.toolId}
              data-exempt-tool-id={row.toolId}
              data-exempt-effect={row.descriptor?.effect ?? 'unknown'}
              className="flex items-center gap-2 rounded-control border border-line bg-ink-950/70 px-2 py-1 text-[11px]"
            >
              <span className="font-medium text-slate-300">
                {t(row.descriptor?.titleKey ?? 'agent.tool.unregistered')}
              </span>
              {row.descriptor ? (
                <EffectChip effect={row.descriptor.effect}>
                  {t(`agent.tool.effect.${row.descriptor.effect}`)}
                </EffectChip>
              ) : (
                // 未登记的工具没有归属色可画——它连副作用是哪一档都不知道，硬涂一色就是谎报。
                <span className="text-slate-500">{t('agent.run.effectUnregistered')}</span>
              )}
              <span className="break-all font-mono text-[10px] text-slate-500">{row.toolId}</span>
              <span className="text-[10px] text-slate-500" data-exempt-added-at={String(row.addedAt)}>
                {t('agent.policy.addedAt', { time: formatAddedAt(row.addedAt) })}
              </span>
              {/* 撤销只是把本机那张表改回去（问人这道闸重新装上），所以是 amber 而不是朱：
                  安全方向的动作不该抢危险色（与岗位屏的拒绝、投递确认单的「先不发」同一口径）。 */}
              <DeskButton
                action="revoke-exempt"
                variant="amber"
                compact
                busy={busy !== undefined}
                disabled={busyReason !== undefined}
                disabledReason={busyReason}
                disabledReasonLabel={busyLabel}
                className="ml-auto"
                onClick={() =>
                  void call(
                    t('agent.policy.actionRevoke', { tool: row.toolId }),
                    () => bridge?.agent['policy.clearExempt'](row.toolId),
                    { apply: setExempt },
                  )
                }
              >
                <X size={10} />
                {t('agent.policy.revoke')}
              </DeskButton>
            </li>
          ))}
        </ul>
      )}

      {candidates.length === 0 ? (
        <p className="mt-2 text-[11px] text-slate-500" data-testid="agent-policy-no-candidates">
          {t('agent.policy.noCandidates')}
        </p>
      ) : (
        <ul data-testid="agent-policy-candidates" className="mt-2 max-h-28 space-y-1 overflow-y-auto">
          {candidates.map((tool) => (
            <li
              key={tool.id}
              data-candidate-tool-id={tool.id}
              data-candidate-effect={tool.effect}
              // 外发候选行默认压暗一档（05 稿第 1 条）：加白之前先看清这只手会不会离开本机。
              className={`flex items-center gap-2 rounded-control border border-line bg-ink-950/40 px-2 py-1 text-[11px] ${
                tool.effect === 'outbound' ? 'opacity-70' : ''
              }`}
            >
              <span className="font-medium text-slate-300">{t(tool.titleKey)}</span>
              {/* 归属色由原件负责，面板只报注册表里那一份读数（§2.7：界面不留第二套事实） */}
              <EffectChip effect={tool.effect}>{t(`agent.tool.effect.${tool.effect}`)}</EffectChip>
              <span className="text-[10px] text-slate-500">{t('agent.tool.needsConfirm')}</span>
              <span className="break-all font-mono text-[10px] text-slate-600">{tool.id}</span>
              {/* 加白把「每次都问人」这道闸松开掉：它按下时什么都不发，但它改变之后每一次外发要不要问你，
                  所以按风险方向给朱（08 稿对该控件的规定）；08 稿同时规定它走**两步 armed**
                  （spec 6.2-11）：第一颗只武装并长出四秒倒计时，四秒内再点第二颗才写库，
                  倒计时走完自动解除。撤销保持一次点——撤回是安全方向，不该加摩擦。 */}
              <ArmButton
                action="add-exempt"
                confirmAction="add-exempt-confirm"
                variant="seal"
                compact
                busy={busy !== undefined}
                disabled={busyReason !== undefined}
                disabledReason={busyReason}
                disabledReasonLabel={busyLabel}
                className="ml-auto"
                armedLabel={
                  <>
                    <ShieldCheck size={10} />
                    {t('agent.policy.armedAdd')}
                  </>
                }
                onConfirm={() =>
                  void call(
                    t('agent.policy.actionAdd', { tool: tool.id }),
                    () => bridge?.agent['policy.setExempt'](tool.id),
                    { apply: setExempt },
                  )
                }
              >
                <ShieldCheck size={10} />
                {t('agent.policy.add')}
              </ArmButton>
            </li>
          ))}
        </ul>
      )}

      {notice ? (
        <p className="mt-2 text-[11px] text-slate-300" data-testid="agent-policy-notice">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
