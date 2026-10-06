import { Eraser, PlugZap, Save } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LlmCheckView, LlmLegName, LlmProviderView, LlmSettingsView } from '@auto-cc/shared';
import { Banner, DeskButton, FIELD_CLASS, deskReason } from './ui/controls';
import { useBridgeAction } from './useBridgeAction';

/**
 * 提供商 id → 语言包键后缀。
 *
 * 目录来自 `llm.settings.catalog()`，里面的 id 是闭合枚举（六家）；界面只给这些 id 配文案，
 * 读回未知 id 时原样显示 id 本身——那是数据不是文案（与 `UpdateSection` 对 `detail` 的口径一致）。
 * @param id 目录里的一条提供商 id
 * @returns `settings.model.provider.<id>` 形态的键
 */
const providerKey = (id: string): string => `settings.model.provider.${id}`;

/** 草稿：只装"人敲过的那一份"。 undefined 表示这一格还没动，读数直接取主进程回的那份。 */
interface SettingsDraft {
  providerId?: string;
  baseUrl?: string;
  model?: string;
}

/**
 * 模型设置分区（spec 7.1-11 / 13）：两条模型腿的端点、模型名与密钥，都在「信任」工作台里配。
 *
 * 为什么挂在这里而不是新开一栏：用户的表态是「新增信任工作台里的设置分区」，
 * 而这一格讲的是"这台机器替谁说话、凭证落在哪"，与登录态、额度同一栏才对得上。
 * 三条不可让的形状（§8.6）：① 明文 key 只进不出——`read()` 回来的只有末 4 位，
 * 输入框因此永不回填；② `encrypted:false` 必须明写，不静默降级；
 * ③ 保存走主进程，界面不自己拼 URL、不自己判齐不齐（那是第二份事实）。
 * @returns 信任工作台里的「模型」小节
 */
export function ModelSettingsPanel() {
  const { t } = useTranslation();
  const bridge = window.autoCC;
  const [view, setView] = useState<LlmSettingsView>();
  const [catalog, setCatalog] = useState<LlmProviderView[]>();
  const [leg, setLeg] = useState<LlmLegName>('chat');
  const [draft, setDraft] = useState<SettingsDraft>();
  const [keyDraft, setKeyDraft] = useState('');
  const [checkResult, setCheckResult] = useState<LlmCheckView | null>(null);

  const read = useCallback(async () => {
    const [settingsReply, catalogReply] = await Promise.all([
      bridge?.llm['settings.read'](),
      bridge?.llm['settings.catalog'](),
    ]);
    if (settingsReply?.ok) setView(settingsReply.value);
    if (catalogReply?.ok) setCatalog(catalogReply.value);
  }, [bridge]);

  useEffect(() => {
    void read();
  }, [read]);

  const legView = view?.legs.find((item) => item.leg === leg);
  const providerId = draft?.providerId ?? legView?.providerId ?? 'custom';
  const baseUrl = draft?.baseUrl ?? legView?.baseUrl ?? '';
  const model = draft?.model ?? legView?.model ?? '';
  /** 这一条腿能选的提供商：目录里 `legs` 含当前腿的那几项（向量腿只有硅基流动与自定义）。 */
  const providers = (catalog ?? []).filter((item) => item.legs.includes(leg));

  /**
   * 换腿：草稿整份撤掉。两条腿的端点与模型名毫无关系，留着上一腿的草稿会让人以为已经填过了。
   * @param next 目标腿
   */
  const switchLeg = (next: LlmLegName): void => {
    setLeg(next);
    setDraft(undefined);
    setKeyDraft('');
    setCheckResult(null);
  };

  /**
   * 选提供商：预设自带端点时把端点一起带进草稿（这正是"支持所有 OpenAI 兼容协议"的省力处），
   * 「自定义」不动端点，让人接着敲。
   * @param next 目录里的提供商 id
   */
  const pickProvider = (next: string): void => {
    const preset = (catalog ?? []).find((item) => item.id === next);
    setDraft({ providerId: next, ...(preset && preset.baseUrl !== '' ? { baseUrl: preset.baseUrl } : {}) });
  };

  const { busy, notice, resultOf, run } = useBridgeAction(read);
  const { dead } = deskReason(t, 'settings.model', busy ? 'ACTION_BUSY' : undefined);
  const saveDead = dead(busy ? 'ACTION_BUSY' : bridge ? undefined : 'BRIDGE_MISSING');
  // 「测试连接」的禁用顺序：先讲这条腿根本不测（向量腿没有 check 的实现），再讲前置数据不齐，最后才是在途。
  const checkDead = dead(
    leg === 'embed'
      ? 'CHECK_NOT_SUPPORTED'
      : legView && !legView.available
        ? 'LEG_INCOMPLETE'
        : busy
          ? 'ACTION_BUSY'
          : undefined,
  );
  const clearDead = dead(legView && legView.key.source === 'none' ? 'NO_KEY_STORED' : busy ? 'ACTION_BUSY' : undefined);

  return (
    <section
      className="rounded-xl border border-line bg-ink-900/60 p-4"
      data-testid="model-settings"
      data-model-leg={leg}
      data-model-encrypted={view?.storage.encrypted ?? 'unknown'}
    >
      <h2 className="text-sm font-semibold text-slate-200">{t('settings.model.heading')}</h2>
      <p className="mt-1 text-xs text-slate-400">{t('settings.model.note')}</p>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-slate-400">{t('settings.model.legLabel')}</span>
          <select
            data-action="settings-model-leg"
            value={leg}
            onChange={(event) => switchLeg(event.target.value as LlmLegName)}
            className={FIELD_CLASS}
          >
            <option value="chat">{t('settings.model.leg.chat')}</option>
            <option value="embed">{t('settings.model.leg.embed')}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-slate-400">{t('settings.model.providerLabel')}</span>
          <select
            data-action="settings-model-provider"
            value={providerId}
            onChange={(event) => pickProvider(event.target.value)}
            className={FIELD_CLASS}
          >
            {!providers.some((item) => item.id === providerId) && <option value={providerId}>{providerId}</option>}
            {providers.map((item) => (
              <option key={item.id} value={item.id}>
                {t(providerKey(item.id))}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-slate-400">{t('settings.model.baseUrlLabel')}</span>
          <input
            data-action="settings-model-base-url"
            value={baseUrl}
            onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
            placeholder={t('settings.model.baseUrlPlaceholder')}
            className={`min-w-0 ${FIELD_CLASS}`}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-slate-400">{t('settings.model.modelLabel')}</span>
          <input
            data-action="settings-model-name"
            value={model}
            onChange={(event) => setDraft({ ...draft, model: event.target.value })}
            placeholder={t('settings.model.modelPlaceholder')}
            className={`min-w-0 ${FIELD_CLASS}`}
          />
        </label>
        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className="text-[10px] text-slate-400">{t('settings.model.keyLabel')}</span>
          {/* type=password + 永不回填：`read()` 只回末 4 位，界面拿不到明文，也就无从显示明文。 */}
          <input
            data-action="settings-model-key"
            type="password"
            value={keyDraft}
            onChange={(event) => setKeyDraft(event.target.value)}
            placeholder={
              legView?.key.present
                ? t('settings.model.keyPlaceholderStored', { tail: legView.key.tail })
                : t('settings.model.keyPlaceholderEmpty')
            }
            className={`min-w-0 ${FIELD_CLASS}`}
          />
          <span className="text-[10px] text-slate-400" data-testid="settings-model-key-source">
            {keySourceLine(legView, t)}
          </span>
        </label>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <DeskButton
          action="settings-model-save"
          variant="amber"
          compact
          busy={busy === 'save'}
          result={resultOf('save')}
          {...saveDead}
          onClick={() =>
            void run(
              'save',
              () => bridge?.llm['settings.apply']({ leg, providerId, baseUrl, model, ...keyInput(keyDraft) }),
              {
                apply: (next) => {
                  setView(next);
                  // 保存成功后草稿清空：输入框接下来显示的必须是主进程刚回的那一份，而不是人敲的旧值。
                  setDraft(undefined);
                  setKeyDraft('');
                },
              },
            )
          }
        >
          <Save size={14} />
          {t('settings.model.save')}
        </DeskButton>
        <DeskButton
          action="settings-model-check"
          variant="jade"
          compact
          busy={busy === 'check'}
          result={resultOf('check')}
          {...checkDead}
          onClick={() =>
            void run('check', () => bridge?.llm['settings.check'](leg), {
              apply: (result) => setCheckResult(result),
            })
          }
        >
          <PlugZap size={14} />
          {t('settings.model.check')}
        </DeskButton>
        <DeskButton
          action="settings-model-clear-key"
          variant="line"
          compact
          busy={busy === 'clear-key'}
          result={resultOf('clear-key')}
          {...clearDead}
          onClick={() =>
            void run('clear-key', () => bridge?.llm['settings.clearKey'](leg), {
              apply: (next) => setView(next),
            })
          }
        >
          <Eraser size={14} />
          {t('settings.model.clearKey')}
        </DeskButton>
      </div>

      <ul className="mt-3 space-y-1 text-xs text-slate-400">
        <li data-testid="settings-model-hot-apply-note">{t('settings.model.noteHotApply')}</li>
        {!!legView && legView.missing.length > 0 && (
          <li className="text-amber" data-testid="settings-model-missing">
            {t('settings.model.missingHeading')}
            {legView.missing.map((field) => (
              <span key={field} className="mr-1 rounded-chip border border-amber/45 bg-amber-wash px-1.5 py-0.5">
                {t(`settings.model.field.${field}`)}
              </span>
            ))}
          </li>
        )}
        {checkResult && (
          <li className={checkResult.ok ? 'text-jade' : 'text-seal'} data-testid="settings-model-check-result">
            {checkResult.ok
              ? t('settings.model.checkOk', { model: checkResult.model ?? '', elapsedMs: checkResult.elapsedMs })
              : t('settings.model.checkFailed', {
                  reason: checkResult.reason ?? '',
                  message: checkResult.message ?? '',
                  elapsedMs: checkResult.elapsedMs,
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
 * `apiKey` 的两种语义：空串＝「这次不动已存的那把」（省略该键），非空＝写这把。
 * @param keyDraft 输入框当下这份（可能为空）
 * @returns 直接 spread 进 `settings.apply` 入参的那一格
 */
function keyInput(keyDraft: string): { apiKey?: string } {
  const trimmed = keyDraft.trim();
  return trimmed === '' ? {} : { apiKey: trimmed };
}

/**
 * 密钥来源那一行：把「现在这把从哪来」说出来，而不是只显示一把掩码。
 * @param legView 当前腿的读数；未到位时返回 undefined
 * @param translate 翻译函数
 * @returns 一句已翻译的话
 */
function keySourceLine(
  legView: LlmSettingsView['legs'][number] | undefined,
  translate: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (!legView) return translate('settings.model.keySource.waiting');
  if (legView.key.source === 'secret') return translate('settings.model.keySource.secret', { tail: legView.key.tail });
  if (legView.key.source === 'env') return translate('settings.model.keySource.env', { env: legView.key.keyEnv });
  return translate('settings.model.keySource.none');
}
