import { PlugZap, Plus, Save, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LlmCheckView, LlmFetchModelsView } from '@auto-cc/shared';
import { DeskButton, DeskCheck, DeskField, DeskSelect, Tag, deskReason } from './ui/controls';
import type { ModelsData } from './useModelsData';
import { encodeCandidate, providerKey, storedModelsOf } from './useModelsData';

/** 新增/编辑实例的草稿：只装人敲过的那一份，切走即整份撤掉。 */
interface ProviderDraft {
  /** 选中的端点变体 id；预设没有变体时为空串 */
  endpointId: string;
  label: string;
  baseUrl: string;
  /** 明文 key 草稿：空串＝不动已存的那把，且永不回填 */
  keyDraft: string;
}

export interface ModelProviderPaneProps {
  data: ModelsData;
  presetId: string;
  /** 当前选中的实例；undefined 表示这家还没建实例，右栏摊新增表单 */
  instanceId?: string;
  onSelectInstance: (providerId: string) => void;
  onAddInstance: () => void;
  onInstanceDeleted: (providerId: string) => void;
}

/**
 * 右栏的提供商配置：实例表单 + 这一家的模型清单。
 *
 * 左栏已经承担"选哪一家"，这里不再长第二份列表；表单常驻是为了对齐截图里的
 * 「左边点一家、右边当场改」——不再需要先点「编辑」才出现输入框。
 * @param props 见 `ModelProviderPaneProps`
 * @returns 右栏内容
 */
export function ModelProviderPane({
  data,
  presetId,
  instanceId,
  onSelectInstance,
  onAddInstance,
  onInstanceDeleted,
}: ModelProviderPaneProps) {
  const { t } = useTranslation();
  const bridge = window.autoCC;
  const preset = data.catalog?.find((item) => item.id === presetId);
  const instances = data.providerRows.filter((row) => row.presetId === presetId);
  const instance = instances.find((row) => row.id === instanceId);
  const stored = storedModelsOf(data, instance?.id);

  const [draft, setDraft] = useState<ProviderDraft>(() => ({
    endpointId: instance?.endpointId ?? preset?.endpoints?.[0]?.id ?? '',
    label: instance?.label ?? (preset && preset.id !== 'custom' ? t(providerKey(preset.id)) : ''),
    baseUrl: instance?.baseUrl ?? preset?.baseUrl ?? '',
    keyDraft: '',
  }));
  const [candidates, setCandidates] = useState<string[]>();
  const [ticked, setTicked] = useState<string[]>([]);
  const [manualModel, setManualModel] = useState('');
  const [modelQuery, setModelQuery] = useState('');
  const [probe, setProbe] = useState<{ target: string; result: LlmCheckView }>();

  const { dead } = deskReason(t, 'settings.model', data.busy ? 'ACTION_BUSY' : undefined);
  const bridgeDead = dead(bridge ? undefined : 'BRIDGE_MISSING').disabledReason;

  /** 两条通道正绑着的 `<实例>::<模型>` 组合，用来挡住"删掉一条正在用的模型"。 */
  const boundCandidates = new Set(
    (data.view?.legs ?? [])
      .filter((item) => item.boundProviderId !== null && item.model !== null)
      .map((item) => encodeCandidate(item.boundProviderId as string, item.model as string)),
  );

  /** 端点变体（方舟标准 / Coding Plan 那一类）：地址跟着变体走，所以两格不是两次表态。 */
  const endpointsOf = preset?.endpoints ?? [];
  const needle = modelQuery.trim().toLowerCase();
  const visibleStored = needle === '' ? stored : stored.filter((item) => item.model.toLowerCase().includes(needle));
  const visibleCandidates =
    candidates === undefined
      ? undefined
      : needle === ''
        ? candidates
        : candidates.filter((item) => item.toLowerCase().includes(needle));

  /**
   * 保存这一家：地址归一、行落库、明文只进密钥库那一格，都在主进程一侧做完。
   * 保存成功后等 `read()` 回来再切到新实例，避免右栏闪一下"新增表单"。
   */
  const saveForm = async (): Promise<void> => {
    const trimmedLabel = draft.label.trim();
    const trimmedBaseUrl = draft.baseUrl.trim();
    const trimmedKey = draft.keyDraft.trim();
    let savedId: string | undefined;
    await data.run(
      'save-provider',
      () =>
        bridge?.llm['settings.saveProvider']({
          ...(instance ? { id: instance.id } : {}),
          presetId,
          label: trimmedLabel,
          baseUrl: trimmedBaseUrl,
          ...(trimmedKey === '' ? {} : { apiKey: trimmedKey }),
        }),
      {
        apply: (row) => {
          savedId = row.id;
          setDraft((current) => ({ ...current, keyDraft: '' }));
        },
        describe: () => t('models.panel.saved', { label: trimmedLabel }),
      },
    );
    if (savedId) onSelectInstance(savedId);
  };

  /**
   * 「获取模型」：只读数、只播报，一条都不入库；已入库的那几条在候选里预选中。
   */
  const fetchModels = (): void => {
    if (!instance) return;
    void data.run('fetch-models', () => bridge?.llm['settings.fetchModels'](instance.id), {
      apply: (result: LlmFetchModelsView) => {
        const storedIds = stored.map((item) => item.model);
        setCandidates(result.ok ? result.models : undefined);
        setTicked(result.ok ? result.models.filter((model) => storedIds.includes(model)) : []);
      },
      describe: (result: LlmFetchModelsView) =>
        result.ok
          ? t('settings.model.modelsFetched', { count: result.models.length, label: instance.label })
          : t('settings.model.fetchFailed', { reason: result.reason ?? '', message: result.message ?? '' }),
    });
  };

  /**
   * 勾选一条候选。
   * @param model 候选里的模型名
   * @param isChecked 目标态
   */
  const toggleCandidate = (model: string, isChecked: boolean): void => {
    setTicked((current) => (isChecked ? [...new Set([...current, model])] : current.filter((item) => item !== model)));
  };

  /**
   * 「添加所选」与「手动添加」共用的入库动作。
   * @param label 动作标签
   * @param models 要入库的模型名
   * @param origin 来源：勾进来的 `fetched`，人敲的 `manual`
   * @param afterStored 落库成功后的本地清理
   */
  const addModels = (label: string, models: string[], origin: 'fetched' | 'manual', afterStored?: () => void): void => {
    if (!instance || models.length === 0) return;
    void data.run(label, () => bridge?.llm['settings.addModels']({ providerId: instance.id, models, origin }), {
      apply: () => {
        setTicked([]);
        afterStored?.();
      },
      describe: () => t('settings.model.modelsStored', { count: models.length, label: instance.label }),
    });
  };

  /**
   * 从清单里摘掉一条（正被某条通道绑着的那条在按钮上先挡住）。
   * @param model 要摘掉的模型名
   */
  const removeStoredModel = (model: string): void => {
    if (!instance) return;
    void data.run('remove-model', () => bridge?.llm['settings.removeModel'](instance.id, model));
  };

  /** 删除这一家：连同模型清单、密钥与通道绑定一起回落。 */
  const deleteInstance = async (): Promise<void> => {
    if (!instance) return;
    const deletedId = instance.id;
    await data.run('delete-provider', () => bridge?.llm['settings.deleteProvider'](deletedId), {
      describe: () => t('desk.done.providerDeleted'),
    });
    onInstanceDeleted(deletedId);
  };

  /**
   * 测这家：有通道正绑着它就用那条模型，否则用清单里排首的那条。
   * @returns 模型名；一条都没入库时是 null
   */
  const probeModelOf = (): string | null => {
    if (!instance) return null;
    const bound = data.view?.legs.find((item) => item.boundProviderId === instance.id && item.model);
    return bound?.model ?? stored[0]?.model ?? null;
  };

  const probeModel = probeModelOf();

  /** 这一格此刻的 key 状态：已存末 4 位，或明写还没填。 */
  const keyStatus = instance?.hasKey
    ? t('settings.model.keyTail', { tail: instance.keyTail })
    : t('settings.model.keyNone');

  return (
    <section
      data-testid="models-provider-pane"
      data-provider-id={instance?.id ?? `new-${presetId}`}
      className="min-w-0"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-50">
            {instance ? instance.label : t('models.panel.newTitle', { provider: t(providerKey(presetId)) })}
          </h3>
          <p className="mt-1 break-all text-[11px] text-slate-400">{instance?.baseUrl ?? preset?.baseUrl}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {instances.length > 0 && (
            <DeskSelect
              action="models-instance-switch"
              value={instance?.id ?? ''}
              onValueChange={onSelectInstance}
              className="w-56 min-w-0"
            >
              {instances.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.label}
                </option>
              ))}
            </DeskSelect>
          )}
          <DeskButton
            action="settings-model-add-provider"
            variant="amber"
            compact
            {...dead(instance ? bridgeDead : 'FORM_ALREADY_OPEN')}
            onClick={onAddInstance}
          >
            <Plus size={14} />
            {t('models.rail.addInstance')}
          </DeskButton>
        </div>
      </div>

      <div
        className="mt-3 grid gap-2 rounded-chip border border-line bg-ink-900/60 p-3 sm:grid-cols-2"
        data-testid="settings-model-form"
      >
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-slate-400">{t('settings.model.labelField')}</span>
          <DeskField
            action="settings-model-form-label"
            value={draft.label}
            onValueChange={(value) => setDraft({ ...draft, label: value })}
            placeholder={t('settings.model.labelPlaceholder')}
            className="min-w-0"
          />
        </label>
        {endpointsOf.length > 1 && (
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-slate-400">{t('settings.model.endpointLabel')}</span>
            <DeskSelect
              action="settings-model-form-endpoint"
              value={draft.endpointId}
              onValueChange={(next) => {
                const endpoint = endpointsOf.find((item) => item.id === next);
                setDraft({ ...draft, endpointId: next, ...(endpoint ? { baseUrl: endpoint.baseUrl } : {}) });
              }}
            >
              {endpointsOf.map((item) => (
                <option key={item.id} value={item.id}>
                  {t(`settings.model.endpoint.${item.id}`)}
                </option>
              ))}
            </DeskSelect>
          </label>
        )}
        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className="text-[10px] text-slate-400">{t('settings.model.baseUrlLabel')}</span>
          <DeskField
            action="settings-model-form-base-url"
            value={draft.baseUrl}
            onValueChange={(value) => setDraft({ ...draft, baseUrl: value })}
            placeholder={t('settings.model.baseUrlPlaceholder')}
            className="min-w-0"
          />
        </label>
        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className="flex flex-wrap items-center gap-2 text-[10px] text-slate-400">
            {t('settings.model.keyLabel')}
            <span data-testid="settings-model-provider-key">{keyStatus}</span>
          </span>
          {/* type=password + 永不回填：主进程只回末 4 位，界面拿不到明文，也就无从显示明文。 */}
          <DeskField
            action="settings-model-form-key"
            type="password"
            value={draft.keyDraft}
            onValueChange={(value) => setDraft({ ...draft, keyDraft: value })}
            placeholder={
              instance
                ? t('settings.model.keyPlaceholderStored', { tail: instance.keyTail })
                : t('settings.model.keyPlaceholderEmpty')
            }
            className="min-w-0"
          />
        </label>
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <DeskButton
            action="settings-model-form-save"
            variant="amber"
            compact
            busy={data.busy === 'save-provider'}
            result={data.resultOf('save-provider')}
            doneLabel={t('desk.done.providerSaved')}
            {...dead(draft.label.trim() === '' || draft.baseUrl.trim() === '' ? 'FORM_INCOMPLETE' : bridgeDead)}
            onClick={() => void saveForm()}
          >
            <Save size={14} />
            {t('models.panel.save')}
          </DeskButton>
          {instance && (
            <DeskButton
              action="settings-model-delete"
              variant="seal"
              compact
              busy={data.busy === 'delete-provider'}
              result={data.resultOf('delete-provider')}
              doneLabel={t('desk.done.providerDeleted')}
              {...dead(bridgeDead)}
              onClick={() => void deleteInstance()}
            >
              <Trash2 size={14} />
              {t('models.panel.delete')}
            </DeskButton>
          )}
        </div>
      </div>

      <div className="mt-3 rounded-chip border border-line bg-ink-900/60 p-3" data-testid="settings-model-models">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-baseline gap-2">
            <h4 className="text-xs font-semibold text-slate-200">{t('settings.model.modelsHeading')}</h4>
            <span className="text-[11px] text-slate-400" data-testid="settings-model-provider-count">
              {t('settings.model.modelCount', { count: stored.length })}
            </span>
          </div>
          <DeskButton
            action="settings-model-fetch"
            variant="line"
            compact
            busy={data.busy === 'fetch-models'}
            result={data.resultOf('fetch-models')}
            doneLabel={t('desk.done.modelsFetched')}
            {...dead(instance ? bridgeDead : 'NO_SAVED_PROVIDER')}
            onClick={fetchModels}
          >
            {t('settings.model.row.fetchModels')}
          </DeskButton>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <DeskField
            action="models-model-search"
            type="search"
            value={modelQuery}
            onValueChange={setModelQuery}
            placeholder={t('models.panel.modelSearchPlaceholder')}
            className="w-48 min-w-0"
          />
          <DeskField
            action="settings-model-manual"
            value={manualModel}
            onValueChange={setManualModel}
            placeholder={t('settings.model.manualPlaceholder')}
            className="w-56 min-w-0"
          />
          <DeskButton
            action="settings-model-add-manual"
            variant="line"
            compact
            busy={data.busy === 'add-manual'}
            result={data.resultOf('add-manual')}
            doneLabel={t('desk.done.modelsAdded')}
            {...dead(!instance ? 'NO_SAVED_PROVIDER' : manualModel.trim() === '' ? 'MANUAL_EMPTY' : bridgeDead)}
            onClick={() => addModels('add-manual', [manualModel.trim()], 'manual', () => setManualModel(''))}
          >
            {t('settings.model.addManual')}
          </DeskButton>
        </div>

        {visibleCandidates !== undefined && (
          <ul className="mt-2 space-y-1" data-testid="settings-model-candidates">
            {visibleCandidates.length === 0 && (
              <li className="text-xs text-slate-400">{t('settings.model.noCandidates')}</li>
            )}
            {visibleCandidates.map((model) => (
              <li key={model} className="flex items-center gap-2 text-xs">
                <DeskCheck
                  action="settings-model-tick"
                  data-model-name={model}
                  checked={ticked.includes(model)}
                  onCheckedChange={(isChecked) => toggleCandidate(model, isChecked)}
                  label={model}
                  className="min-w-0"
                />
                {stored.some((item) => item.model === model) && (
                  <span className="text-[10px] text-slate-500" data-testid="settings-model-already-stored">
                    {t('settings.model.alreadyStored')}
                  </span>
                )}
              </li>
            ))}
            <li>
              <DeskButton
                action="settings-model-add-selected"
                variant="amber"
                compact
                busy={data.busy === 'add-models'}
                result={data.resultOf('add-models')}
                doneLabel={t('desk.done.modelsAdded')}
                {...dead(
                  candidates === undefined ? 'NOT_FETCHED' : ticked.length === 0 ? 'NOTHING_TICKED' : bridgeDead,
                )}
                onClick={() => addModels('add-models', ticked, 'fetched')}
              >
                {t('settings.model.addSelected', { count: ticked.length })}
              </DeskButton>
            </li>
          </ul>
        )}

        <ul className="mt-2" data-testid="settings-model-stored">
          {stored.length === 0 && <li className="text-xs text-slate-400">{t('settings.model.storedEmpty')}</li>}
          {stored.length > 0 && visibleStored.length === 0 && (
            <li className="text-xs text-slate-400">{t('models.panel.noModelsFiltered')}</li>
          )}
          {visibleStored.map((item) => {
            const candidate = encodeCandidate(item.providerId, item.model);
            return (
              <li
                key={candidate}
                data-model-name={item.model}
                className="flex min-w-0 flex-wrap items-center gap-2 border-t border-line/70 py-1.5 text-xs first:border-t-0"
              >
                <span className="min-w-0 flex-1 truncate text-slate-200">{item.model}</span>
                <Tag tone={item.origin === 'manual' ? 'amber' : undefined}>
                  {t(`settings.model.origin.${item.origin}`)}
                </Tag>
                <DeskButton
                  action="settings-model-remove"
                  variant="seal"
                  compact
                  busy={data.busy === 'remove-model'}
                  result={data.resultOf('remove-model')}
                  doneLabel={t('desk.done.modelRemoved')}
                  {...dead(boundCandidates.has(candidate) ? 'MODEL_BOUND' : bridgeDead)}
                  onClick={() => removeStoredModel(item.model)}
                >
                  {t('settings.model.row.remove')}
                </DeskButton>
              </li>
            );
          })}
        </ul>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <DeskButton
            action="settings-model-check-provider"
            variant="jade"
            compact
            busy={data.busy === 'check-provider'}
            result={data.resultOf('check-provider')}
            doneLabel={t('desk.done.checked')}
            {...dead(probeModel === null ? 'NO_MODEL_STORED' : bridgeDead)}
            onClick={() => {
              if (!instance || !probeModel) return;
              void data.run('check-provider', () => bridge?.llm['settings.checkProvider'](instance.id, probeModel), {
                apply: (result) => setProbe({ target: `${instance.label} · ${probeModel}`, result }),
              });
            }}
          >
            <PlugZap size={14} />
            {t('settings.model.row.check')}
          </DeskButton>
        </div>
        {probe && (
          <p
            className={probe.result.ok ? 'mt-2 text-[11px] text-jade' : 'mt-2 text-[11px] text-seal'}
            data-testid="settings-model-check-result"
          >
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
          </p>
        )}
      </div>
    </section>
  );
}
