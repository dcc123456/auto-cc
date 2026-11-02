import { Eraser, PlugZap, Save } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LlmCheckView, LlmLegName, LlmLegView } from '@auto-cc/shared';
import { DeskButton, DeskSelect, Tag, deskReason } from './ui/controls';
import type { ModelsData } from './useModelsData';
import { decodeCandidate, encodeCandidate, keySourceLine, storedModelsOf } from './useModelsData';

export interface ModelDefaultsPaneProps {
  data: ModelsData;
  /** 没有任何可绑模型时，把焦点送回左栏的提供商列表 */
  onGoProviders: () => void;
}

/**
 * 右栏的默认模型：对话与向量各从已入库清单里挑一条。
 *
 * 候选值的扁平编码与旧面板同源（`<实例 id>::<模型名>`），因为同一条模型名可以在两家各存一份；
 * 这里只负责选与保存，真正的持久化与热改仍在 `bindRole`。
 * @param props 见 `ModelDefaultsPaneProps`
 * @returns 默认模型右栏
 */
export function ModelDefaultsPane({ data, onGoProviders }: ModelDefaultsPaneProps) {
  const { t } = useTranslation();
  const bridge = window.autoCC;
  const [drafts, setDrafts] = useState<Partial<Record<LlmLegName, string>>>({});
  const [probe, setProbe] = useState<{ target: string; result: LlmCheckView }>();

  const { dead } = deskReason(t, 'settings.model', data.busy ? 'ACTION_BUSY' : undefined);
  const bridgeDead = dead(bridge ? undefined : 'BRIDGE_MISSING').disabledReason;

  /**
   * 全部实例 × 各家已入库模型 = 两条通道的候选；没有 key 的实例也收，
   * 但标签里明写「未填密钥」——yml/env 兜底口径不变，选它是合法表态。
   */
  const options = data.providerRows.flatMap((row) =>
    storedModelsOf(data, row.id).map((item) => ({
      value: encodeCandidate(row.id, item.model),
      label: row.hasKey
        ? `${row.label} · ${item.model}`
        : `${row.label} · ${item.model} · ${t('models.defaults.noKeyTag')}`,
    })),
  );

  /**
   * 一条通道的下拉当前值：人敲过的草稿优先，否则由主进程那份绑定拼回来。
   * @param legView 这条通道的读数
   */
  const boundValueOf = (legView?: LlmLegView): string =>
    legView?.boundProviderId && legView.model ? encodeCandidate(legView.boundProviderId, legView.model) : '';

  /**
   * 把一条通道指到某个实例的某条已入库模型。
   * @param leg 哪条通道
   */
  const bindLeg = (leg: LlmLegName): void => {
    const target = decodeCandidate(drafts[leg] ?? '');
    if (!target) return;
    void data.run(`bind-${leg}`, () => bridge?.llm['settings.bindRole']({ leg, ...target }), {
      apply: () => setDrafts((current) => ({ ...current, [leg]: undefined })),
    });
  };

  /**
   * 清除这一路已存的密钥。
   *
   * `clearKey(leg)` 清的是 `llm.chat` / `llm.embed` 两格兜底密钥；绑定实例时真正在用的是
   * `llm.provider:<id>`，这一按清不动它。所以绑定态一律挡住并说出原因，实例密钥交给「删除实例」。
   * @param leg 哪条通道
   * @param legView 这条通道的读数
   */
  const clearReason = (leg: LlmLegName, legView?: LlmLegView): string | undefined => {
    if (legView?.origin === 'pool') return 'LEG_BOUND_KEY';
    if (legView?.key.source !== 'secret') return 'NO_KEY_STORED';
    return bridgeDead;
  };

  return (
    <section data-testid="models-defaults-pane" className="min-w-0">
      <h3 className="text-sm font-semibold text-slate-50">{t('models.defaults.heading')}</h3>
      <p className="mt-1 text-xs text-slate-400">{t('models.defaults.note')}</p>

      {options.length === 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="models-defaults-empty">
          <p className="text-[11px] text-slate-400">{t('models.defaults.empty')}</p>
          <DeskButton action="models-defaults-go-providers" variant="line" compact onClick={onGoProviders}>
            {t('models.defaults.goProviders')}
          </DeskButton>
        </div>
      )}

      <ul className="mt-3 flex flex-col rounded-chip border border-line bg-ink-900/60 px-3">
        {(['chat', 'embed'] as const).map((leg) => {
          const legView = data.view?.legs.find((item) => item.leg === leg);
          const boundLabel = data.providerRows.find((row) => row.id === legView?.boundProviderId)?.label ?? '';
          const value = drafts[leg] ?? boundValueOf(legView);
          const unchanged = value === boundValueOf(legView);
          return (
            <li key={leg} data-model-leg={leg} className="border-t border-line/70 py-3 first:border-t-0">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <span className="text-xs font-semibold text-slate-200">{t(`settings.model.leg.${leg}`)}</span>
                <span className="text-[11px] text-slate-400" data-testid="settings-model-leg-origin">
                  {t(`settings.model.legOrigin.${legView?.origin ?? 'none'}`, { label: boundLabel })}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <DeskSelect
                  action={`settings-model-bind-${leg}`}
                  value={value}
                  onValueChange={(next) => setDrafts({ ...drafts, [leg]: next })}
                  className="w-80 min-w-0"
                  {...dead(options.length === 0 ? 'NO_STORED_MODEL' : bridgeDead)}
                >
                  {options.length === 0 && <option value="">{t('settings.model.bindingEmpty')}</option>}
                  {options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </DeskSelect>
                <DeskButton
                  action={`settings-model-bind-save-${leg}`}
                  variant="amber"
                  compact
                  busy={data.busy === `bind-${leg}`}
                  result={data.resultOf(`bind-${leg}`)}
                  doneLabel={t('desk.done.roleBound')}
                  {...dead(
                    decodeCandidate(value) === null ? 'BIND_INCOMPLETE' : unchanged ? 'BIND_UNCHANGED' : bridgeDead,
                  )}
                  onClick={() => bindLeg(leg)}
                >
                  <Save size={14} />
                  {t('settings.model.bindingSave')}
                </DeskButton>
                <DeskButton
                  action={`settings-model-check-${leg}`}
                  variant="jade"
                  compact
                  busy={data.busy === `check-${leg}`}
                  result={data.resultOf(`check-${leg}`)}
                  doneLabel={t('desk.done.checked')}
                  {...dead(
                    leg === 'embed'
                      ? 'CHECK_NOT_SUPPORTED'
                      : legView && !legView.available
                        ? 'LEG_INCOMPLETE'
                        : bridgeDead,
                  )}
                  onClick={() =>
                    void data.run(`check-${leg}`, () => bridge?.llm['settings.check'](leg), {
                      apply: (result) => setProbe({ target: t(`settings.model.leg.${leg}`), result }),
                    })
                  }
                >
                  <PlugZap size={14} />
                  {t('settings.model.check')}
                </DeskButton>
                <DeskButton
                  action={`settings-model-clear-key-${leg}`}
                  variant="line"
                  compact
                  busy={data.busy === `clear-key-${leg}`}
                  result={data.resultOf(`clear-key-${leg}`)}
                  doneLabel={t('desk.done.clearedKey')}
                  {...dead(clearReason(leg, legView))}
                  onClick={() => void data.run(`clear-key-${leg}`, () => bridge?.llm['settings.clearKey'](leg))}
                >
                  <Eraser size={14} />
                  {t('settings.model.clearKey')}
                </DeskButton>
              </div>
              <ul className="mt-2 space-y-1 text-[11px] text-slate-400">
                <li data-testid={`settings-model-key-source-${leg}`}>{keySourceLine(legView, t)}</li>
                {!!legView && legView.missing.length > 0 && (
                  <li className="text-amber" data-testid={`settings-model-missing-${leg}`}>
                    {t('settings.model.missingHeading')}
                    {legView.missing.map((field) => (
                      <Tag key={field} tone="amber" className="mr-1">
                        {t(`settings.model.field.${field}`)}
                      </Tag>
                    ))}
                  </li>
                )}
              </ul>
            </li>
          );
        })}
      </ul>

      <ul className="mt-3 space-y-1 text-xs text-slate-400">
        <li data-testid="settings-model-hot-apply-note">{t('settings.model.noteHotApply')}</li>
        {probe && (
          <li className={probe.result.ok ? 'text-jade' : 'text-seal'} data-testid="settings-model-check-result">
            {probe.result.ok
              ? t('settings.model.checkOk', {
                  model: `${probe.target} · ${probe.result.model ?? ''}`,
                  elapsedMs: probe.result.elapsedMs,
                })
              : t('settings.model.checkFailed', {
                  reason: probe.result.reason ?? '',
                  message: probe.result.message ?? '',
                  elapsedMs: probe.result.elapsedMs,
                })}
          </li>
        )}
      </ul>
    </section>
  );
}
