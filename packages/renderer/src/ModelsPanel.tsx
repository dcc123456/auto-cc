import { SlidersHorizontal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LlmSettingsView } from '@auto-cc/shared';
import { Banner, BLOCK_SELECTED_CLASS, DeskButton, DeskField } from './ui/controls';
import { ModelDefaultsPane } from './ModelDefaultsPane';
import { ModelProviderPane } from './ModelProviderPane';
import { providerKey, useModelsData } from './useModelsData';

/** 右栏当前显示什么：默认模型，或某家提供商的某个实例（缺实例＝新增表单）。 */
type RailSelection = { kind: 'defaults' } | { kind: 'preset'; presetId: string; instanceId?: string };

/**
 * 模型工作台：左栏提供商清单 + 右栏配置/默认模型。
 *
 * 绿点的判据是「这家至少有一个实例」而不是「有 key」——用户原话是"已添加过配置"，
 * 而 Ollama / LM Studio / vLLM 这类本地提供商本来就可以不填 key。key 有无在右栏以文字报出。
 * @returns 两栏页
 */
export function ModelsPanel() {
  const { t } = useTranslation();
  const data = useModelsData();
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState<RailSelection>({ kind: 'defaults' });

  /**
   * 选中的实例被删掉之后，右栏回到这一家的新增表单（池里可能还剩别的实例，交给人再点）。
   */
  useEffect(() => {
    if (selection.kind !== 'preset' || !selection.instanceId) return;
    if (!data.providerRows.some((row) => row.id === selection.instanceId)) {
      setSelection({ kind: 'preset', presetId: selection.presetId });
    }
  }, [data.providerRows, selection]);

  const catalog = data.catalog ?? [];
  const instancesOf = (presetId: string) => data.providerRows.filter((row) => row.presetId === presetId);

  /**
   * 选中一家预设：有实例就落到第一个，没有就让右栏摊新增表单。
   * @param presetId 目录里的预设 id
   */
  const pickPreset = (presetId: string): void => {
    const first = instancesOf(presetId)[0];
    setSelection({ kind: 'preset', presetId, ...(first ? { instanceId: first.id } : {}) });
  };

  /** 没有任何可绑模型时，把焦点送回第一家还没配置的提供商；都配过了就回第一家。 */
  const goProviders = (): void => {
    const firstEmpty = catalog.find(
      (preset) => preset.id !== 'custom' && !data.providerRows.some((row) => row.presetId === preset.id),
    );
    const target = firstEmpty ?? catalog[0];
    if (target) pickPreset(target.id);
  };

  const needle = query.trim().toLowerCase();
  const visible = catalog.filter((preset) => {
    if (needle === '') return true;
    const rows = instancesOf(preset.id);
    const haystack = [
      t(providerKey(preset.id)),
      preset.id,
      preset.baseUrl,
      ...rows.flatMap((row) => [row.label, row.baseUrl]),
    ];
    return haystack.some((item) => item.toLowerCase().includes(needle));
  });

  if (!data.isReady) {
    return (
      <p className="text-xs text-slate-400" data-testid="models-loading">
        {t('models.loading')}
      </p>
    );
  }

  if (!window.autoCC || !data.catalog) {
    return (
      <Banner tone="seal" reason="BRIDGE_MISSING">
        {t('models.bridgeMissing')}
      </Banner>
    );
  }

  const selectedPreset =
    selection.kind === 'preset' ? catalog.find((preset) => preset.id === selection.presetId) : undefined;

  return (
    <section className="@container min-w-0" data-testid="models-page">
      <div className="grid min-w-0 gap-4 @2xl:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
        <aside className="min-w-0 rounded-xl border border-line bg-ink-900/40 p-2" data-testid="models-rail">
          <div className="flex flex-col gap-2">
            <DeskField
              action="models-rail-search"
              type="search"
              value={query}
              onValueChange={setQuery}
              placeholder={t('models.rail.searchPlaceholder')}
              className="min-w-0"
            />
            <DeskButton
              action="models-rail-defaults"
              variant={selection.kind === 'defaults' ? 'solid' : 'ghost'}
              compact
              className="w-full justify-start"
              onClick={() => setSelection({ kind: 'defaults' })}
            >
              <SlidersHorizontal size={13} />
              {t('models.rail.defaults')}
            </DeskButton>
            <p className="px-1 pt-1 text-[11px] text-slate-500">{t('models.rail.heading')}</p>
            <ul className="flex min-w-0 flex-col" data-testid="settings-model-providers" data-rail="providers">
              {visible.map((preset) => {
                const rows = instancesOf(preset.id);
                const configured = rows.length > 0;
                const isSelected = selection.kind === 'preset' && selection.presetId === preset.id;
                return (
                  <li key={preset.id} className="flex min-w-0 flex-col">
                    <DeskButton
                      action="settings-model-pick-provider"
                      variant="ghost"
                      compact
                      className={`w-full justify-start ${isSelected ? BLOCK_SELECTED_CLASS : ''}`}
                      markers={{
                        'provider-id': preset.id,
                        configured: configured ? 'true' : 'false',
                        testid: 'models-rail-provider',
                      }}
                      onClick={() => pickPreset(preset.id)}
                    >
                      <span className="flex h-1.5 w-1.5 shrink-0 items-center justify-center" aria-hidden="true">
                        {configured ? (
                          <span
                            data-testid="models-rail-dot"
                            aria-label={t('models.rail.configured')}
                            className="h-1.5 w-1.5 rounded-full bg-jade"
                          />
                        ) : null}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{t(providerKey(preset.id))}</span>
                      {configured && rows.length > 1 ? (
                        <span className="text-[10px] text-slate-500">{rows.length}</span>
                      ) : null}
                    </DeskButton>
                    {configured && rows.length > 1 ? (
                      <ul className="ml-3 flex min-w-0 flex-col border-l border-line pl-2">
                        {rows.map((row) => (
                          <li key={row.id} className="flex min-w-0">
                            <DeskButton
                              action="settings-model-pick-instance"
                              variant="ghost"
                              compact
                              className={`w-full justify-start ${
                                isSelected && selection.kind === 'preset' && selection.instanceId === row.id
                                  ? BLOCK_SELECTED_CLASS
                                  : ''
                              }`}
                              markers={{ 'provider-id': row.id, testid: 'models-rail-instance' }}
                              onClick={() => setSelection({ kind: 'preset', presetId: preset.id, instanceId: row.id })}
                            >
                              <span className="min-w-0 flex-1 truncate text-[11px]">{row.label}</span>
                              <span className="min-w-0 max-w-32 truncate text-[10px] text-slate-500">
                                {row.baseUrl}
                              </span>
                            </DeskButton>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {visible.length === 0 && (
              <p className="px-1 text-[11px] text-slate-400" data-testid="models-rail-no-match">
                {t('models.rail.noMatch')}
              </p>
            )}
          </div>
        </aside>

        <div className="min-w-0">
          {selection.kind === 'defaults' ? (
            <ModelDefaultsPane data={data} onGoProviders={goProviders} />
          ) : selectedPreset ? (
            <ModelProviderPane
              key={`${selectedPreset.id}:${selection.instanceId ?? 'new'}`}
              data={data}
              presetId={selectedPreset.id}
              instanceId={selection.instanceId}
              onSelectInstance={(instanceId) =>
                setSelection({ kind: 'preset', presetId: selectedPreset.id, instanceId })
              }
              onAddInstance={() => setSelection({ kind: 'preset', presetId: selectedPreset.id })}
              onInstanceDeleted={(deletedId) => {
                const rest = instancesOf(selectedPreset.id).filter((row) => row.id !== deletedId);
                setSelection({
                  kind: 'preset',
                  presetId: selectedPreset.id,
                  ...(rest[0] ? { instanceId: rest[0].id } : {}),
                });
              }}
            />
          ) : (
            <p className="text-xs text-slate-400">{t('models.rail.noMatch')}</p>
          )}
          {data.notice && (
            <p className="mt-3 break-all text-xs text-slate-300" data-testid="settings-model-notice">
              {data.notice}
            </p>
          )}
          <StorageNotice storage={data.view?.storage} />
        </div>
      </div>
    </section>
  );
}

/**
 * 密钥库的如实播报：未加密明写，解不开用朱砂，加密时只留一行说明。
 * @param storage `llm.settings.read()` 的存储读数；还没读到时是 undefined
 * @returns 横幅或一行说明
 */
function StorageNotice({ storage }: { storage: LlmSettingsView['storage'] | undefined }) {
  const { t } = useTranslation();
  if (!storage) return null;
  return (
    <>
      {!storage.encrypted && (
        <Banner
          tone="amber"
          reason="STORAGE_PLAINTEXT"
          className="mt-3"
          markers={{ 'storage-file': storage.file ?? 'unknown' }}
        >
          {t('settings.model.storagePlain')}
        </Banner>
      )}
      {storage.unreadable && (
        <Banner tone="seal" reason="SECRET_UNREADABLE" className="mt-3">
          {t('settings.model.storageUnreadable')}
        </Banner>
      )}
      {storage.encrypted && (
        <p className="mt-2 text-[10px] text-slate-500" data-testid="settings-model-storage-encrypted">
          {t('settings.model.storageEncrypted')}
        </p>
      )}
    </>
  );
}
