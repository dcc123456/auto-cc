import { Eraser, PlugZap, Plus, Save, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  LlmCheckView,
  LlmFetchModelsView,
  LlmLegName,
  LlmLegView,
  LlmModelView,
  LlmProviderInstanceView,
  LlmProviderView,
  LlmSettingsView,
} from '@auto-cc/shared';
import { Banner, DeskButton, DeskCheck, DeskField, DeskSelect, Tag, deskReason } from './ui/controls';
import { useBridgeAction } from './useBridgeAction';

/**
 * 提供商 id → 语言包键后缀。
 *
 * 目录来自 `llm.settings.catalog()`，里面的 id 是闭合枚举（19 家，spec 7.2-01）；界面只给这些 id 配文案，
 * 读回未知 id 时原样显示 id 本身——那是数据不是文案（与 `UpdateSection` 对 `detail` 的口径一致）。
 * @param id 目录里的一条提供商 id
 * @returns `settings.model.provider.<id>` 形态的键
 */
const providerKey = (id: string): string => `settings.model.provider.${id}`;

/**
 * 角色绑定下拉的候选值分隔符。
 *
 * 必须写成**扁平的一串**而不是"两家 + 两模型"四个格子：同一条模型名可以在两家下面各存一份
 * （`llm_models` 的主键是 `(provider_id, model)`，spec 7.2-06），只报名字就挑不出"哪家的这一条"。
 * 实例 id 是 UUID，不含这串字符，所以按第一个分隔符切开就是唯一解。
 */
const CANDIDATE_SEP = '::';

/** 拼一条候选值（`<实例 id>::<模型名>`）。 */
const encodeCandidate = (providerId: string, model: string): string => `${providerId}${CANDIDATE_SEP}${model}`;

/**
 * 拆一条候选值。
 * @param value 下拉的值；空串表示还没选
 * @returns `{providerId, model}`；空串或没带分隔符时回 null（保存键此时按不动）
 */
function decodeCandidate(value: string): { providerId: string; model: string } | null {
  const at = value.indexOf(CANDIDATE_SEP);
  if (at <= 0 || at + CANDIDATE_SEP.length >= value.length) return null;
  return { providerId: value.slice(0, at), model: value.slice(at + CANDIDATE_SEP.length) };
}

/** 添加/编辑提供商实例的草稿：只装人敲过的那一份，取消即整份撤掉。 */
interface ProviderForm {
  /** 编辑时那一行的 id；新增为 undefined */
  id?: string;
  /** 目录里的预设 id */
  presetId: string;
  /** 选中的端点变体 id；预设没有变体时为空串 */
  endpointId: string;
  label: string;
  baseUrl: string;
  /** 明文 key 草稿：空串＝不动已存的那把（与 7.1 掩码框同一条语义），且永不回填 */
  keyDraft: string;
}

/** 一次探测的落点：对谁测的（界面上的那一行名字）与主进程回的结果。 */
interface ProbeReading {
  target: string;
  result: LlmCheckView;
}

/**
 * 模型设置分区（spec 7.2-02 ~ 11）：同时管好几家提供商，各家的模型清单勾进本机，再从中给 chat 与 embed 各挑一条。
 *
 * 三段一体的理由就是用户提的那件事：「同时添加火山引擎/openAI/deepseek，添加时获取模型列表、勾选模型，
 * 然后从已添加的模型里给 chat 和 embed 各选一条」是一条动作链，拆成三处就变成"只有工程师知道怎么串起来"
 * （AGENTS.md §5.9）。三条不可让的形状（§8.6）：① 明文 key 只进不出——`listProviders()` 只回末 4 位，
 * 密钥框因此永不回填；② `encrypted:false` 必须明写，不静默降级；③ 落盘一律走主进程：界面不判"这家绑了
 * 哪条模型"、不拼端点、不猜清单（那是第二份事实，§2.5）。
 * @returns 信任工作台里的「模型」小节
 */
export function ModelSettingsPanel() {
  const { t } = useTranslation();
  const bridge = window.autoCC;
  const [view, setView] = useState<LlmSettingsView>();
  const [catalog, setCatalog] = useState<LlmProviderView[]>();
  const [providerRows, setProviderRows] = useState<LlmProviderInstanceView[]>([]);
  /** 每家已入库的清单，按实例 id 分格：第二段显示选中那家，第三段的候选来自全部家。 */
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, LlmModelView[]>>({});
  const [selectedId, setSelectedId] = useState<string>();
  /** 「获取模型」拿回来的候选（还没入库的那一份），与人在候选里勾中的那几条。 */
  const [candidates, setCandidates] = useState<string[]>();
  const [ticked, setTicked] = useState<string[]>([]);
  const [manualModel, setManualModel] = useState('');
  /** 两条腿各自的下拉草稿（没动过的腿就是空对象里缺的那一键，值直接取主进程回的那份绑定）。 */
  const [bindingDraft, setBindingDraft] = useState<Partial<Record<LlmLegName, string>>>({});
  const [form, setForm] = useState<ProviderForm>();
  const [probe, setProbe] = useState<ProbeReading>();

  /**
   * 重读整份事实：两条腿 + 目录 + 池 + 每家的清单。
   *
   * 每家的清单逐家现问而不在主进程攒一份：条数就是家数（个位数，全是本地 SQL），而"攒一份"等于在池
   * 之外再造一个真相（§2.5）——用户删掉一家之后那份缓存还得有人去擦。
   */
  const read = useCallback(async () => {
    const [settingsReply, catalogReply, providersReply] = await Promise.all([
      bridge?.llm['settings.read'](),
      bridge?.llm['settings.catalog'](),
      bridge?.llm['settings.listProviders'](),
    ]);
    if (settingsReply?.ok) setView(settingsReply.value);
    if (catalogReply?.ok) setCatalog(catalogReply.value);
    if (!providersReply?.ok) return;
    const rows = providersReply.value;
    setProviderRows(rows);
    setSelectedId((current) => (current && rows.some((row) => row.id === current) ? current : rows[0]?.id));
    const listings = await Promise.all(rows.map(async (row) => bridge?.llm['settings.listModels'](row.id)));
    const next: Record<string, LlmModelView[]> = {};
    listings.forEach((reply, index) => {
      if (reply?.ok) next[rows[index]!.id] = reply.value;
    });
    setModelsByProvider(next);
  }, [bridge]);

  useEffect(() => {
    void read();
  }, [read]);

  const { busy, notice, resultOf, run } = useBridgeAction(read);
  const { dead } = deskReason(t, 'settings.model', busy ? 'ACTION_BUSY' : undefined);
  /** 桥接不在时整段按不动：这一分区所有动作都要过主进程，没有本地回落可言。 */
  const bridgeDead = dead(bridge ? undefined : 'BRIDGE_MISSING').disabledReason;

  const selected = providerRows.find((row) => row.id === selectedId);
  const storedOf = (providerId: string | undefined): LlmModelView[] =>
    (providerId === undefined ? undefined : modelsByProvider[providerId]) ?? [];
  const stored = storedOf(selected?.id);
  const legViewOf = (leg: LlmLegName): LlmLegView | undefined => view?.legs.find((item) => item.leg === leg);

  /** 两条腿正绑着的 `<实例>::<模型>` 组合，用来挡住"删掉一条正在用的模型"。 */
  const boundCandidates = new Set(
    (view?.legs ?? [])
      .filter((item) => item.boundProviderId !== null && item.model !== null)
      .map((item) => encodeCandidate(item.boundProviderId as string, item.model as string)),
  );

  /**
   * 全部家 × 各家已入库的模型 = 两条腿的候选（spec 7.2-11 的"从我已经添加的模型里选"）。
   *
   * 标签写成「显示名 · 模型名」：`DeskSelect` 的选项是 children，原件层没有 `<optgroup>` 的先例
   * （plan §7.5 的待核项已实测确认），而扁平值 `<实例>::<模型>` 才能把"两家都有同名模型"挑开。
   */
  const bindingOptions = providerRows.flatMap((row) =>
    storedOf(row.id).map((item) => ({
      value: encodeCandidate(row.id, item.model),
      label: `${row.label} · ${item.model}`,
    })),
  );

  /**
   * 把某一家设为当前操作对象：行级按钮的忙碌/结果读数只长在选中那一行上，免得五家同时显示"已获取"。
   * @param row 池里的一行
   */
  const focusRow = (row: LlmProviderInstanceView): void => {
    setSelectedId(row.id);
    setCandidates(undefined);
    setTicked([]);
  };

  /**
   * 「获取模型」（spec 7.2-05 / 07）：只读数、只播报，一条都不入库；已入库的那几条在候选里预选中，
   * 让人一眼看出"这家我已经勾过了"。
   * @param row 要点名探测的实例
   */
  const fetchCandidates = (row: LlmProviderInstanceView): void => {
    focusRow(row);
    void run('fetch-models', () => bridge?.llm['settings.fetchModels'](row.id), {
      apply: (result: LlmFetchModelsView) => {
        const storedIds = storedOf(row.id).map((item) => item.model);
        setCandidates(result.ok ? result.models : undefined);
        setTicked(result.ok ? result.models.filter((model) => storedIds.includes(model)) : []);
      },
      describe: (result: LlmFetchModelsView) =>
        result.ok
          ? t('settings.model.modelsFetched', { count: result.models.length, label: row.label })
          : t('settings.model.fetchFailed', { reason: result.reason ?? '', message: result.message ?? '' }),
    });
  };

  /** 新建提供商的草稿：默认走「自定义」，不替人选一家他没提过的。 */
  const startAdd = (): void => {
    setForm({ presetId: 'custom', endpointId: '', label: '', baseUrl: '', keyDraft: '' });
  };

  /**
   * 编辑已有的一行：地址与显示名回填，**密钥不回填**（主进程只回末 4 位，明文出不了主进程）。
   * @param row 池里的一行
   */
  const startEdit = (row: LlmProviderInstanceView): void => {
    setSelectedId(row.id);
    setForm({
      id: row.id,
      presetId: row.presetId,
      endpointId: row.endpointId ?? '',
      label: row.label,
      baseUrl: row.baseUrl,
      keyDraft: '',
    });
  };

  /**
   * 选预设：自带端点时把端点与显示名一起填上（这正是"支持所有 OpenAI 兼容协议"的省力处），
   * 「自定义」不动地址，让人接着敲。
   * @param next 目录里的预设 id
   */
  const pickPreset = (next: string): void => {
    const preset = (catalog ?? []).find((item) => item.id === next);
    setForm((current) => {
      if (!current) return current;
      return {
        ...current,
        presetId: next,
        endpointId: preset?.endpoints?.[0]?.id ?? '',
        ...(preset && preset.baseUrl !== '' ? { baseUrl: preset.baseUrl } : {}),
        ...(current.label === '' && preset ? { label: t(providerKey(preset.id)) } : {}),
      };
    });
  };

  /**
   * 选端点变体（方舟标准 / Coding Plan、智谱三条那一类）：地址跟着变体走，所以两格不是两次表态。
   * @param next 变体 id；空串 = 这家没有变体
   */
  const pickEndpoint = (next: string): void => {
    const preset = (catalog ?? []).find((item) => item.id === form?.presetId);
    const endpoint = preset?.endpoints?.find((item) => item.id === next);
    setForm((current) => {
      if (!current) return current;
      return {
        ...current,
        endpointId: next,
        ...(endpoint ? { baseUrl: endpoint.baseUrl } : {}),
      };
    });
  };

  /** 保存这一家：地址归一、行落库、明文只进密钥库那一格，都在主进程一侧做完（spec 7.2-03 / 10）。 */
  const saveForm = (): void => {
    if (!form) return;
    const trimmedKey = form.keyDraft.trim();
    void run(
      'save-provider',
      () =>
        bridge?.llm['settings.saveProvider']({
          ...(form.id === undefined ? {} : { id: form.id }),
          presetId: form.presetId,
          label: form.label.trim(),
          baseUrl: form.baseUrl.trim(),
          ...(trimmedKey === '' ? {} : { apiKey: trimmedKey }),
        }),
      {
        apply: (row) => {
          setForm(undefined);
          focusRow(row);
        },
      },
    );
  };

  /**
   * 勾中/取消一条候选。
   * @param model 候选里的模型名
   * @param isChecked 目标态
   */
  const toggleCandidate = (model: string, isChecked: boolean): void => {
    setTicked((current) => (isChecked ? [...new Set([...current, model])] : current.filter((item) => item !== model)));
  };

  /**
   * 「添加所选」与「手动添加这一条」共用的入库动作（spec 7.2-06）。
   * @param label 动作标签（忙碌与结果读数都挂它）
   * @param models 要入库的模型名
   * @param origin 来源：勾进来的 `fetched`，人敲的 `manual`
   * @param afterStored 落库成功后追加的一次本地清理（手敲那格要用）
   */
  const addStoredModels = (
    label: string,
    models: string[],
    origin: 'fetched' | 'manual',
    afterStored?: () => void,
  ): void => {
    if (!selected) return;
    const providerId = selected.id;
    void run(label, () => bridge?.llm['settings.addModels']({ providerId, models, origin }), {
      apply: (rows) => {
        setModelsByProvider((current) => ({ ...current, [providerId]: rows }));
        afterStored?.();
      },
      describe: (rows) => t('settings.model.modelsStored', { count: rows.length, label: selected.label }),
    });
  };

  /**
   * 从清单里摘掉一条（正被某条腿绑着的那条在按钮上先挡住，见 `boundCandidates`）。
   * @param row 池里的一行
   * @param model 要摘掉的模型名
   */
  const removeStoredModel = (row: LlmProviderInstanceView, model: string): void => {
    void run('remove-model', () => bridge?.llm['settings.removeModel'](row.id, model), {
      apply: (rows) => setModelsByProvider((current) => ({ ...current, [row.id]: rows })),
    });
  };

  /**
   * 把一条腿指到某个实例的某条已入库模型（spec 7.2-11）：只写实例 id 与模型名两格，端点由池当场给。
   * @param leg 哪条腿
   */
  const bindLeg = (leg: LlmLegName): void => {
    const target = decodeCandidate(bindingDraft[leg] ?? '');
    if (!target) return;
    void run(`bind-${leg}`, () => bridge?.llm['settings.bindRole']({ leg, ...target }), {
      apply: (next) => {
        setView(next);
        setBindingDraft((current) => ({ ...current, [leg]: undefined }));
      },
    });
  };

  /**
   * 一条腿的下拉当前值：人敲过的草稿优先，否则由主进程那份绑定拼回来。
   * @param legView 这条腿的读数
   */
  const boundValueOf = (legView?: LlmLegView): string =>
    legView?.boundProviderId && legView.model ? encodeCandidate(legView.boundProviderId, legView.model) : '';

  /**
   * 「测这家」点名哪条模型名：有腿正绑着它就用那条，否则用清单里排首的那条。
   * @param row 要探测的实例
   * @returns 模型名；这家一条都还没入库时回 null（按钮此时按不动）
   */
  const probeModelOf = (row: LlmProviderInstanceView): string | null => {
    const bound = view?.legs.find((item) => item.boundProviderId === row.id && item.model);
    return bound?.model ?? storedOf(row.id)[0]?.model ?? null;
  };

  /** 这家预设暴露的端点变体（只有一家有多条时才长那一格）。 */
  const endpointsOf = (presetId: string): Array<{ id: string; baseUrl: string }> =>
    (catalog ?? []).find((item) => item.id === presetId)?.endpoints ?? [];

  return (
    <section
      className="rounded-xl border border-line bg-ink-900/60 p-4"
      data-testid="model-settings"
      data-model-encrypted={view?.storage.encrypted ?? 'unknown'}
      data-provider-count={providerRows.length}
    >
      <h2 className="text-sm font-semibold text-slate-200">{t('settings.model.heading')}</h2>
      <p className="mt-1 text-xs text-slate-400">{t('settings.model.note')}</p>

      {/* —— 第一段：提供商实例池（spec 7.2-02 / 03 / 09）—— */}
      <div className="mt-3 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-slate-300">{t('settings.model.providersHeading')}</h3>
        <DeskButton
          action="settings-model-add-provider"
          variant="amber"
          compact
          {...dead(form !== undefined ? 'FORM_ALREADY_OPEN' : bridgeDead)}
          onClick={startAdd}
        >
          <Plus size={14} />
          {t('settings.model.addProvider')}
        </DeskButton>
      </div>
      <ul className="mt-2 space-y-1" data-testid="settings-model-providers">
        {providerRows.length === 0 && (
          <li className="text-xs text-slate-400" data-testid="settings-model-providers-empty">
            {t('settings.model.providersEmpty')}
          </li>
        )}
        {providerRows.map((row) => {
          const isFocused = row.id === selectedId;
          const probeModel = probeModelOf(row);
          return (
            <li
              key={row.id}
              data-provider-id={row.id}
              data-provider-selected={isFocused ? 'true' : 'false'}
              className={`flex flex-wrap items-center gap-2 rounded-chip border px-2 py-1.5 text-xs ${
                isFocused ? 'border-celadon/60 bg-ink-900' : 'border-line'
              }`}
            >
              <DeskButton
                action="settings-model-pick-provider"
                variant="ghost"
                compact
                className="min-w-0 flex-1 justify-start"
                markers={{ 'data-pick-provider-id': row.id }}
                {...dead(bridgeDead)}
                onClick={() => focusRow(row)}
              >
                <span className="min-w-0 truncate">{row.label}</span>
                <span className="min-w-0 truncate text-[11px] text-slate-500">{row.baseUrl}</span>
              </DeskButton>
              {row.endpointId === null && <Tag>{t('settings.model.customEndpoint')}</Tag>}
              <span className="text-[11px] text-slate-400" data-testid="settings-model-provider-key">
                {row.hasKey ? t('settings.model.keyTail', { tail: row.keyTail }) : t('settings.model.keyNone')}
              </span>
              <span className="text-[11px] text-slate-400" data-testid="settings-model-provider-count">
                {t('settings.model.modelCount', { count: row.modelCount })}
              </span>
              <DeskButton
                action="settings-model-fetch"
                variant="line"
                compact
                busy={isFocused && busy === 'fetch-models'}
                result={isFocused ? resultOf('fetch-models') : undefined}
                doneLabel={t('desk.done.modelsFetched')}
                {...dead(bridgeDead)}
                onClick={() => fetchCandidates(row)}
              >
                {t('settings.model.row.fetchModels')}
              </DeskButton>
              <DeskButton
                action="settings-model-check-provider"
                variant="jade"
                compact
                busy={isFocused && busy === 'check-provider'}
                result={isFocused ? resultOf('check-provider') : undefined}
                doneLabel={t('desk.done.checked')}
                {...dead(probeModel === null ? 'NO_MODEL_STORED' : bridgeDead)}
                onClick={() => {
                  if (!probeModel) return;
                  focusRow(row);
                  void run('check-provider', () => bridge?.llm['settings.checkProvider'](row.id, probeModel), {
                    apply: (result) => setProbe({ target: `${row.label} · ${probeModel}`, result }),
                  });
                }}
              >
                <PlugZap size={14} />
                {t('settings.model.row.check')}
              </DeskButton>
              <DeskButton
                action="settings-model-edit"
                variant="line"
                compact
                {...dead(form !== undefined ? 'FORM_ALREADY_OPEN' : bridgeDead)}
                onClick={() => startEdit(row)}
              >
                {t('settings.model.row.edit')}
              </DeskButton>
              <DeskButton
                action="settings-model-delete"
                variant="seal"
                compact
                busy={isFocused && busy === 'delete-provider'}
                result={isFocused ? resultOf('delete-provider') : undefined}
                doneLabel={t('desk.done.providerDeleted')}
                {...dead(bridgeDead)}
                onClick={() =>
                  void run('delete-provider', () => bridge?.llm['settings.deleteProvider'](row.id), {
                    apply: () => {
                      setCandidates(undefined);
                      setTicked([]);
                      setForm(undefined);
                    },
                  })
                }
              >
                <Trash2 size={14} />
                {t('settings.model.row.delete')}
              </DeskButton>
            </li>
          );
        })}
      </ul>

      {/* 添加/编辑是**内联**表单而不是第六只遮罩：`Modal` 的入场条件是"不可逆或必须读完整风险"
          （见 `ui/overlays.tsx` 那条纪律），而换一家提供商两头都不占，随时能取消回去。 */}
      {form && (
        <div className="mt-2 rounded-chip border border-celadon/40 bg-ink-900 p-3" data-testid="settings-model-form">
          <h4 className="text-xs font-semibold text-slate-200">
            {t(form.id === undefined ? 'settings.model.form.titleAdd' : 'settings.model.form.titleEdit')}
          </h4>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-slate-400">{t('settings.model.providerLabel')}</span>
              <DeskSelect action="settings-model-form-preset" value={form.presetId} onValueChange={pickPreset}>
                {presetOptions(form.presetId, catalog).map((id) => (
                  <option key={id} value={id}>
                    {t(providerKey(id))}
                  </option>
                ))}
              </DeskSelect>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-slate-400">{t('settings.model.labelField')}</span>
              <DeskField
                action="settings-model-form-label"
                value={form.label}
                onValueChange={(value) => setForm({ ...form, label: value })}
                placeholder={t('settings.model.labelPlaceholder')}
                className="min-w-0"
              />
            </label>
            {endpointsOf(form.presetId).length > 1 && (
              <label className="flex flex-col gap-1">
                <span className="text-[10px] text-slate-400">{t('settings.model.endpointLabel')}</span>
                <DeskSelect action="settings-model-form-endpoint" value={form.endpointId} onValueChange={pickEndpoint}>
                  {endpointsOf(form.presetId).map((item) => (
                    <option key={item.id} value={item.id}>
                      {t(`settings.model.endpoint.${item.id}`)}
                    </option>
                  ))}
                </DeskSelect>
              </label>
            )}
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-slate-400">{t('settings.model.baseUrlLabel')}</span>
              <DeskField
                action="settings-model-form-base-url"
                value={form.baseUrl}
                onValueChange={(value) => setForm({ ...form, baseUrl: value })}
                placeholder={t('settings.model.baseUrlPlaceholder')}
                className="min-w-0"
              />
            </label>
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-[10px] text-slate-400">{t('settings.model.keyLabel')}</span>
              {/* type=password + 永不回填：主进程只回末 4 位，界面拿不到明文，也就无从显示明文。 */}
              <DeskField
                action="settings-model-form-key"
                type="password"
                value={form.keyDraft}
                onValueChange={(value) => setForm({ ...form, keyDraft: value })}
                placeholder={
                  form.id === undefined
                    ? t('settings.model.keyPlaceholderEmpty')
                    : t('settings.model.keyPlaceholderStored', {
                        tail: providerRows.find((row) => row.id === form.id)?.keyTail ?? '',
                      })
                }
                className="min-w-0"
              />
            </label>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <DeskButton
              action="settings-model-form-save"
              variant="amber"
              compact
              busy={busy === 'save-provider'}
              result={resultOf('save-provider')}
              doneLabel={t('desk.done.providerSaved')}
              {...dead(form.label.trim() === '' || form.baseUrl.trim() === '' ? 'FORM_INCOMPLETE' : bridgeDead)}
              onClick={saveForm}
            >
              <Save size={14} />
              {t('settings.model.form.save')}
            </DeskButton>
            <DeskButton action="settings-model-form-cancel" variant="line" compact onClick={() => setForm(undefined)}>
              <X size={14} />
              {t('settings.model.form.cancel')}
            </DeskButton>
          </div>
        </div>
      )}

      {/* —— 第二段：这一家的模型清单（spec 7.2-05 / 06 / 07）—— */}
      <h3 className="mt-4 text-xs font-semibold text-slate-300">{t('settings.model.modelsHeading')}</h3>
      {!selected ? (
        <p className="mt-1 text-xs text-slate-400" data-testid="settings-model-no-provider">
          {t('settings.model.modelsNeedProvider')}
        </p>
      ) : (
        <div className="mt-2 space-y-2" data-testid="settings-model-models" data-selected-provider-id={selected.id}>
          <p className="text-[11px] text-slate-400">{t('settings.model.modelsOf', { label: selected.label })}</p>
          {candidates !== undefined && (
            <ul className="space-y-1" data-testid="settings-model-candidates">
              {candidates.length === 0 && (
                <li className="text-xs text-slate-400">{t('settings.model.noCandidates')}</li>
              )}
              {candidates.map((model) => (
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
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <DeskButton
              action="settings-model-add-selected"
              variant="amber"
              compact
              busy={busy === 'add-models'}
              result={resultOf('add-models')}
              doneLabel={t('desk.done.modelsAdded')}
              {...dead(candidates === undefined ? 'NOT_FETCHED' : ticked.length === 0 ? 'NOTHING_TICKED' : bridgeDead)}
              onClick={() => addStoredModels('add-models', ticked, 'fetched')}
            >
              {t('settings.model.addSelected', { count: ticked.length })}
            </DeskButton>
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
              busy={busy === 'add-manual'}
              result={resultOf('add-manual')}
              doneLabel={t('desk.done.modelsAdded')}
              {...dead(manualModel.trim() === '' ? 'MANUAL_EMPTY' : bridgeDead)}
              onClick={() => addStoredModels('add-manual', [manualModel.trim()], 'manual', () => setManualModel(''))}
            >
              {t('settings.model.addManual')}
            </DeskButton>
          </div>
          <ul className="space-y-1" data-testid="settings-model-stored">
            {stored.length === 0 && <li className="text-xs text-slate-400">{t('settings.model.storedEmpty')}</li>}
            {stored.map((item) => {
              const candidate = encodeCandidate(item.providerId, item.model);
              return (
                <li key={candidate} data-model-name={item.model} className="flex items-center gap-2 text-xs">
                  <span className="min-w-0 flex-1 truncate text-slate-200">{item.model}</span>
                  <Tag tone={item.origin === 'manual' ? 'amber' : undefined}>
                    {t(`settings.model.origin.${item.origin}`)}
                  </Tag>
                  <DeskButton
                    action="settings-model-remove"
                    variant="seal"
                    compact
                    busy={busy === 'remove-model'}
                    result={resultOf('remove-model')}
                    doneLabel={t('desk.done.modelRemoved')}
                    {...dead(boundCandidates.has(candidate) ? 'MODEL_BOUND' : bridgeDead)}
                    onClick={() => removeStoredModel(selected, item.model)}
                  >
                    {t('settings.model.row.remove')}
                  </DeskButton>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* —— 第三段：两条腿各自从已入库的模型里挑一条（spec 7.2-11 / 12）—— */}
      <h3 className="mt-4 text-xs font-semibold text-slate-300">{t('settings.model.bindingHeading')}</h3>
      <ul className="mt-2 space-y-3">
        {(['chat', 'embed'] as const).map((leg) => {
          const legView = legViewOf(leg);
          const boundLabel = providerRows.find((row) => row.id === legView?.boundProviderId)?.label ?? '';
          const value = bindingDraft[leg] ?? boundValueOf(legView);
          const unchanged = value === boundValueOf(legView);
          return (
            <li key={leg} data-model-leg={leg} className="rounded-chip border border-line p-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-xs font-semibold text-slate-200">{t(`settings.model.leg.${leg}`)}</span>
                <span className="text-[11px] text-slate-400" data-testid="settings-model-leg-origin">
                  {t(`settings.model.legOrigin.${legView?.origin ?? 'none'}`, { label: boundLabel })}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <DeskSelect
                  action={`settings-model-bind-${leg}`}
                  value={value}
                  onValueChange={(next) => setBindingDraft({ ...bindingDraft, [leg]: next })}
                  className="w-80 min-w-0"
                  {...dead(bindingOptions.length === 0 ? 'NO_STORED_MODEL' : bridgeDead)}
                >
                  {bindingOptions.length === 0 && <option value="">{t('settings.model.bindingEmpty')}</option>}
                  {bindingOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </DeskSelect>
                <DeskButton
                  action={`settings-model-bind-save-${leg}`}
                  variant="amber"
                  compact
                  busy={busy === `bind-${leg}`}
                  result={resultOf(`bind-${leg}`)}
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
                  busy={busy === `check-${leg}`}
                  result={resultOf(`check-${leg}`)}
                  doneLabel={t('desk.done.checked')}
                  {...dead(
                    leg === 'embed'
                      ? 'CHECK_NOT_SUPPORTED'
                      : legView && !legView.available
                        ? 'LEG_INCOMPLETE'
                        : bridgeDead,
                  )}
                  onClick={() =>
                    void run(`check-${leg}`, () => bridge?.llm['settings.check'](leg), {
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
                  busy={busy === `clear-key-${leg}`}
                  result={resultOf(`clear-key-${leg}`)}
                  doneLabel={t('desk.done.clearedKey')}
                  {...dead(legView?.key.source === 'secret' ? bridgeDead : 'NO_KEY_STORED')}
                  onClick={() =>
                    void run(`clear-key-${leg}`, () => bridge?.llm['settings.clearKey'](leg), {
                      apply: (next) => setView(next),
                    })
                  }
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
        {notice && (
          <li className="break-all text-slate-300" data-testid="settings-model-notice">
            {notice}
          </li>
        )}
      </ul>

      {view && !view.storage.encrypted && (
        <Banner
          tone="amber"
          reason="STORAGE_PLAINTEXT"
          className="mt-3"
          markers={{ 'storage-file': view.storage.file ?? 'unknown' }}
        >
          {t('settings.model.storagePlain')}
        </Banner>
      )}
      {view?.storage.unreadable && (
        <Banner tone="seal" reason="SECRET_UNREADABLE" className="mt-3">
          {t('settings.model.storageUnreadable')}
        </Banner>
      )}
      {view?.storage.encrypted && (
        <p className="mt-2 text-[10px] text-slate-500" data-testid="settings-model-storage-encrypted">
          {t('settings.model.storageEncrypted')}
        </p>
      )}
    </section>
  );
}

/**
 * 预设下拉要渲染的 id：目录里的全部，外加草稿里那个可能已不在目录里的（读回未知 id 时原样显示）。
 * @param current 草稿当前的预设 id
 * @param catalog 目录读数；还没回来时是 undefined
 * @returns 要渲染的 id 列表
 */
function presetOptions(current: string, catalog?: LlmProviderView[]): string[] {
  const ids = (catalog ?? []).map((item) => item.id);
  return ids.includes(current) ? ids : [current, ...ids];
}

/**
 * 密钥来源那一行：把「现在这把从哪来」说出来，而不是只显示一把掩码。
 * @param legView 这条腿的读数；还没到位时是 undefined
 * @param translate 翻译函数
 * @returns 一句已翻译的话
 */
function keySourceLine(
  legView: LlmLegView | undefined,
  translate: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (!legView) return translate('settings.model.keySource.waiting');
  if (legView.key.source === 'secret') return translate('settings.model.keySource.secret', { tail: legView.key.tail });
  if (legView.key.source === 'env') return translate('settings.model.keySource.env', { env: legView.key.keyEnv });
  return translate('settings.model.keySource.none');
}
