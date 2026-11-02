import { useCallback, useEffect, useState } from 'react';
import type {
  LlmLegView,
  LlmModelView,
  LlmProviderInstanceView,
  LlmProviderView,
  LlmSettingsView,
} from '@auto-cc/shared';
import { useBridgeAction } from './useBridgeAction';

/**
 * 角色绑定下拉的候选值分隔符。
 *
 * 必须写成**扁平的一串**而不是"两家 + 两模型"四个格子：同一条模型名可以在两家下面各存一份
 * （`llm_models` 的主键是 `(provider_id, model)`，spec 7.2-06），只报名字就挑不出"哪家的这一条"。
 * 实例 id 是 UUID，不含这串字符，所以按第一个分隔符切开就是唯一解。
 */
export const CANDIDATE_SEP = '::';

/**
 * 拼一条候选值（`<实例 id>::<模型名>`）。
 * @param providerId 实例 id
 * @param model 模型名
 * @returns 下拉用的扁平值
 */
export const encodeCandidate = (providerId: string, model: string): string => `${providerId}${CANDIDATE_SEP}${model}`;

/**
 * 拆一条候选值。
 * @param value 下拉的值；空串表示还没选
 * @returns `{providerId, model}`；空串或没带分隔符时回 null
 */
export function decodeCandidate(value: string): { providerId: string; model: string } | null {
  const at = value.indexOf(CANDIDATE_SEP);
  if (at <= 0 || at + CANDIDATE_SEP.length >= value.length) return null;
  return { providerId: value.slice(0, at), model: value.slice(at + CANDIDATE_SEP.length) };
}

/**
 * 提供商 id → 语言包键后缀。
 * @param id 目录里的一条提供商 id
 * @returns `settings.model.provider.<id>` 形态的键
 */
export const providerKey = (id: string): string => `settings.model.provider.${id}`;

/**
 * 密钥来源那一行：把「现在这把从哪来」说出来，而不是只显示一把掩码。
 * @param legView 这条通道的读数；还没到位时是 undefined
 * @param translate 翻译函数
 * @returns 一句已翻译的话
 */
export function keySourceLine(
  legView: LlmLegView | undefined,
  translate: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (!legView) return translate('settings.model.keySource.waiting');
  if (legView.key.source === 'secret') return translate('settings.model.keySource.secret', { tail: legView.key.tail });
  if (legView.key.source === 'env') return translate('settings.model.keySource.env', { env: legView.key.keyEnv });
  return translate('settings.model.keySource.none');
}

/** 模型工作台的一份事实：目录、实例池、每家清单与公共动作外壳。 */
export type ModelsData = ReturnType<typeof useBridgeAction> & {
  /** 两条通道的读数与密钥库状态 */
  view?: LlmSettingsView;
  /** 24 家目录；还没读到时是 undefined */
  catalog?: LlmProviderView[];
  /** 池里的实例，按添加先后 */
  providerRows: LlmProviderInstanceView[];
  /** 每家实例已入库的模型，按实例 id 分格 */
  modelsByProvider: Record<string, LlmModelView[]>;
  /** 第一次读取是否完成；页面据此区分"加载中"与"确实一家都没有" */
  isReady: boolean;
  /** 重读整份事实 */
  read: () => Promise<void>;
};

/**
 * 模型工作台的读口与动作外壳。
 *
 * 每家的清单逐家现问而不在主进程攒一份：条数就是家数（个位数，全是本地 SQL），而"攒一份"等于在池
 * 之外再造一个真相（§2.5）——用户删掉一家之后那份缓存还得有人去擦。
 * @returns 目录、实例池、每家清单、加载态与 `useBridgeAction` 的公共动作
 */
export function useModelsData(): ModelsData {
  const bridge = window.autoCC;
  const [view, setView] = useState<LlmSettingsView>();
  const [catalog, setCatalog] = useState<LlmProviderView[]>();
  const [providerRows, setProviderRows] = useState<LlmProviderInstanceView[]>([]);
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, LlmModelView[]>>({});
  const [isReady, setIsReady] = useState(false);

  /**
   * 重读整份事实：两条通道 + 目录 + 池 + 每家的清单。
   * @returns 读取完成（不抛；单条失败只是这一格不更新）
   */
  const read = useCallback(async () => {
    const [settingsReply, catalogReply, providersReply] = await Promise.all([
      bridge?.llm['settings.read'](),
      bridge?.llm['settings.catalog'](),
      bridge?.llm['settings.listProviders'](),
    ]);
    if (settingsReply?.ok) setView(settingsReply.value);
    if (catalogReply?.ok) setCatalog(catalogReply.value);
    if (providersReply?.ok) {
      const rows = providersReply.value;
      setProviderRows(rows);
      const listings = await Promise.all(rows.map(async (row) => bridge?.llm['settings.listModels'](row.id)));
      const next: Record<string, LlmModelView[]> = {};
      listings.forEach((reply, index) => {
        if (reply?.ok) next[rows[index]!.id] = reply.value;
      });
      setModelsByProvider(next);
    }
    setIsReady(true);
  }, [bridge]);

  useEffect(() => {
    void read();
  }, [read]);

  const actions = useBridgeAction(read);
  return { ...actions, view, catalog, providerRows, modelsByProvider, isReady, read };
}

/**
 * 某一家的已入库清单。
 * @param data 工作台事实
 * @param providerId 实例 id；undefined 表示还没有选中实例
 * @returns 模型行；没读过这一家时是空数组
 */
export const storedModelsOf = (data: ModelsData, providerId: string | undefined): LlmModelView[] =>
  (providerId === undefined ? undefined : data.modelsByProvider[providerId]) ?? [];
