import { Database, Download, Pencil, Plus, RefreshCw, Search, Trash2, Upload } from 'lucide-react';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  KbEntityKindView,
  KbEntityRowView,
  KbEvidenceRowView,
  KbImportModeView,
  KbSearchRowHit,
  KbSearchRowResult,
} from '@auto-cc/shared';
import { useBridgeAction } from './useBridgeAction';

/** 实体种类 → 文案键（四类在界面上的各自说法，英文串不直接上界面，对齐 §5.5）。 */
const KIND_LABEL_KEY: Record<KbEntityKindView, string> = {
  experience: 'kb.kindExperience',
  project: 'kb.kindProject',
  skill: 'kb.kindSkill',
  achievement: 'kb.kindAchievement',
};

/** 反查命中理由 → 文案键（`contains` 与 `overlap` 在界面是两句不同的话，分数只是它们共同的强度读数）。 */
const REASON_LABEL_KEY: Record<KbEvidenceRowView['reason'], string> = {
  contains: 'kb.reasonContains',
  overlap: 'kb.reasonOverlap',
};

/** 检索命中的通道 / 分数腿 → 文案键（四个码各说一件事：靠 BM25 排上来、靠词面覆盖、只被子串通道接住、只被语义相近捞到）。 */
const SEARCH_REASON_LABEL_KEY: Record<KbSearchRowResult['hits'][number]['reasons'][number], string> = {
  bm25: 'kb.searchReasonBm25',
  lexical: 'kb.searchReasonLexical',
  substring: 'kb.searchReasonSubstring',
  vector: 'kb.searchReasonVector',
};

/**
 * 向量腿当次状态 → 文案键（spec 4.3-08：降级必须看得见，否则界面给出的只是「三条词面命中」这种读不出原因的形态）。
 *
 * `not_attempted` 不在表里：那一态只在查询切不出 token 时出现，界面那时正在说「这句话没词」，
 * 再补一句「没做语义增强」是噪声而不是信息。
 */
const VECTOR_STATUS_LABEL_KEY: Record<Exclude<KbSearchRowResult['vectorStatus'], 'not_attempted'>, string> = {
  ok: 'kb.vectorStatusOk',
  unavailable: 'kb.vectorStatusUnavailable',
  no_vectors: 'kb.vectorStatusNoVectors',
  failed: 'kb.vectorStatusFailed',
};

/** 变更动作 → 文案键（事件载荷里的动作码，界面按它说「刚发生了什么」）。 */
const ACTION_LABEL_KEY: Record<'create' | 'update' | 'remove' | 'sync' | 'import', string> = {
  create: 'kb.actionCreate',
  update: 'kb.actionUpdate',
  remove: 'kb.actionRemove',
  sync: 'kb.actionSync',
  import: 'kb.actionImport',
};

/** 编辑器里的一条：`entityId` 为 `null` 表示新建（新建还没有 id，id 由主进程生成）。 */
type EditingDraft = { entityId: string | null; kind: KbEntityKindView; lines: string };

/**
 * 载荷 → `key=value` 行文本（界面上唯一的载荷表示形式）。
 * @param payload 实体的扁平载荷
 * @returns 按键升序的 `key=value` 多行串——排序是为了让「打开编辑器再保存」不被键序变化污染
 */
function payloadToLines(payload: Readonly<Record<string, string>>): string {
  return Object.keys(payload)
    .sort()
    .map((key) => `${key}=${payload[key]}`)
    .join('\n');
}

/**
 * `key=value` 行文本 → 载荷。
 * @param lines 编辑器全文
 * @returns 解析出的键值对；空行与不含 `=` 的行直接忽略（用户留白是常态，主进程那边才判「载荷为空」）
 */
function linesToPayload(lines: string): Record<string, string> {
  const payload: Record<string, string> = {};
  for (const line of lines.split('\n')) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key !== '' && value !== '') payload[key] = value;
  }
  return payload;
}

/**
 * 实体在列表里的一行主文案：取载荷第一个值（按 `title → name → description` 的常规优先）。
 * @param entity 实体读数
 * @returns 一句短文本；派生与手工都走同一条规则，界面不猜各自的键名
 */
function primaryTextOf(entity: KbEntityRowView): string {
  const preferred = ['title', 'name', 'description', 'role', 'company'];
  for (const key of preferred) {
    const value = entity.payload[key];
    if (value) return value;
  }
  return Object.values(entity.payload)[0] ?? entity.entityId;
}

/**
 * 知识库管理面板（spec 4.2-05 / 06 的界面化身，裁定三）：实体树 + 展开证据链 + 编辑即时生效。
 *
 * 三件事在界面上是刻意的，读代码的人不该重新推断：
 * 1. **按来源给两套处置**——派生实体（`sourceDocId` 非空）不给删除按钮，只标「来自简历 xxx」并让「同步」
 *    成为它的唯一写入口；给它挂删除按钮等于挂一个必然失败的按钮（4.2-04）。手工实体才可删可编辑。
 * 2. **一切读数重取自主进程**：每个动作结束后靠 `kb/entities-changed` 事件触发 `list()`，界面不自己改本地态，
 *    也不轮询（4.2-06「即时生效」的判据就是这个：编辑完不重启、不手动刷新就能看到新值）。
 * 3. **证据链由主进程的确定性反查给出**：展开一条卡片等于拿它的正文去 `evidenceFor`，
 *    分数、理由码、命中词全部来自 `evidence.ts`，界面不重算一遍（§2.5）。
 */
export function KbPanel() {
  const { t } = useTranslation();
  const [entities, setEntities] = useState<KbEntityRowView[]>([]);
  const [expandedId, setExpandedId] = useState<string>();
  const [evidence, setEvidence] = useState<KbEvidenceRowView[]>([]);
  const [claim, setClaim] = useState('');
  const [searchText, setSearchText] = useState('');
  const [searchResult, setSearchResult] = useState<KbSearchRowResult>();
  const [editing, setEditing] = useState<EditingDraft>();
  const [docId, setDocId] = useState('');
  const [backupPath, setBackupPath] = useState('');
  const [importMode, setImportMode] = useState<KbImportModeView>('skip');
  const bridge = window.autoCC;

  /**
   * 重读整棵实体树（4.2-05 的数据源）：界面不缓存"上次的内容"，主进程才是真相。
   */
  const read = useCallback(async () => {
    const reply = await bridge?.kb['profile.list']();
    if (reply?.ok) setEntities(reply.value);
  }, [bridge]);

  const { busy, notice, run, setNotice } = useBridgeAction(read);

  /**
   * 订阅知识库变更事件（4.2-06）：新增/编辑/删除/同步/导入之后由主进程推一条信号，界面据此重读。
   * 提示行只说「刚发生了什么、影响几行」，内容一律来自重读结果。
   */
  useEffect(() => {
    void read();
    if (!bridge) return;
    return bridge.on('kb/entities-changed', (event) => {
      setNotice(t('kb.changed', { action: t(ACTION_LABEL_KEY[event.action]), count: event.changed }));
      // 库被改过之后上一批检索结果就是陈旧的（切片可能已删）；清空比留着更诚实，界面也不去猜哪条还在。
      setSearchResult(undefined);
      void read();
    });
  }, [bridge, read, setNotice, t]);

  /**
   * 从简历工作副本重新派生实体（4.2-01 的幂等同步，也是 4.2-04 里「在简历里删掉再来同步」的那一步）。
   */
  const syncFromDoc = () =>
    void run(t('kb.sync'), () => bridge?.kb['profile.sync'](docId.trim()), {
      describe: (value) => t('kb.syncDone', { created: value.created, updated: value.updated, removed: value.removed }),
    });

  /**
   * 反查一句陈述的证据链（4.2-03 的界面入口）：空数组是正常态而不是失败，界面据此显示「查无支撑」。
   * @param text 待反查的陈述
   * @param expandId 命中后要展开的实体 id（展开某条卡片时传它自己的 id，好把证据链挂在那一行下面）
   */
  const lookUpEvidence = (text: string, expandId?: string) =>
    void run(t('kb.evidence'), () => bridge?.kb['profile.evidenceFor'](text), {
      apply: (hits) => {
        setEvidence(hits);
        setExpandedId(hits.length > 0 ? expandId : undefined);
      },
      describe: (hits) => (hits.length === 0 ? t('kb.evidenceEmpty') : t('kb.evidenceCount', { count: hits.length })),
    });

  /**
   * 在本地知识库检索（spec 4.3-01 / 4.3-10 的界面入口）：召回、打分、理由与命中词全部在主进程算完再过来，
   * 界面只负责把三个态说成三句不同的话——
   * `no_query_tokens`（这句切不出词）、`ok` + 空 `hits`（库里确实没有沾边的）、有命中。
   * 前两个都必须给一句可行动建议，空结果不是失败（4.3-10 的判据）。
   */
  const runSearch = () =>
    void run(t('kb.search'), () => bridge?.kb['profile.search'](searchText.trim()), {
      apply: (value) => setSearchResult(value),
      describe: (value) =>
        value.status === 'no_query_tokens'
          ? t('kb.searchNoTokens')
          : value.hits.length === 0
            ? t('kb.searchNoHitsCount')
            : t('kb.searchCount', { count: value.hits.length }),
    });

  /**
   * 保存编辑器内容：`editing.entityId` 为空走新建（手工实体，永不被同步清理），非空走载荷覆盖。
   */
  const saveDraft = () => {
    const draft = editing;
    if (!draft) return;
    const payload = linesToPayload(draft.lines);
    if (draft.entityId === null) {
      void run(t('kb.create'), () => bridge?.kb['profile.create']({ kind: draft.kind, payload }), {
        apply: (view) => {
          setEditing(undefined);
          setExpandedId(view.entityId);
        },
        describe: (view) => t('kb.created', { entityId: view.entityId }),
      });
      return;
    }
    const entityId = draft.entityId;
    void run(t('kb.save'), () => bridge?.kb['profile.update'](entityId, payload), {
      apply: () => setEditing(undefined),
      describe: (view) => t('kb.saved', { entityId: view.entityId }),
    });
  };

  /**
   * 删除一条**手工**实体（4.2-04）：下属解除归属而不是连带删除，所以回执里的两个计数都要说出来。
   * @param entityId 待删实体 id
   */
  const removeEntity = (entityId: string) =>
    void run(t('kb.delete'), () => bridge?.kb['profile.remove'](entityId), {
      describe: (value) => t('kb.removed', { entityId: value.entityId, detached: value.detached }),
    });

  /**
   * 导出全库为本地 JSON 备份（4.2-08）：路径由用户给，父目录必须已存在，写不出去以结构化失败上浮。
   */
  const exportBackup = () =>
    void run(t('kb.export'), () => bridge?.kb['profile.exportBackup'](backupPath.trim()), {
      describe: (value) => t('kb.exportDone', { exported: value.exported, filePath: value.filePath }),
    });

  /**
   * 从本地 JSON 备份导入（4.2-08）：单事务，中途一条不合法整批回滚；默认策略 `skip` 不动用户已有数据。
   */
  const importBackup = () =>
    void run(t('kb.import'), () => bridge?.kb['profile.importBackup'](backupPath.trim(), importMode), {
      describe: (value) =>
        t('kb.importDone', {
          created: value.created,
          overwritten: value.overwritten,
          skipped: value.skipped,
          danglingParents: value.danglingParents,
        }),
    });

  /**
   * 打开编辑器。
   * @param entity 要编辑的实体；新建时传 `undefined`（种类默认经验）
   */
  const openEditor = (entity?: KbEntityRowView) =>
    setEditing(
      entity
        ? { entityId: entity.entityId, kind: entity.kind, lines: payloadToLines(entity.payload) }
        : { entityId: null, kind: 'experience', lines: 'title=\ndescription=' },
    );

  /** 根节点（无归属）在前，其下属按 `parentId` 挂在下面——层级关系只从库里的 `parentId` 推导，界面不另存一份。 */
  const roots = entities.filter((entity) => entity.parentId === null);
  const childrenOf = (entityId: string) => entities.filter((entity) => entity.parentId === entityId);

  /**
   * 一条检索命中的出处说法（4.3-10：结果行要看得出「这是哪来的」）。
   * 实体级切片的 `chunkId` 就是实体 id，所以能在已经读到的实体树里查到它的种类；
   * 查不到（例如刚被删掉、树还没重读）就退回切片种类本身——界面不猜一个标签出来。
   * @param hit 一条检索命中
   * @returns 一句短标签；区块级复用简历区块的既有文案键，不另起一套说法（§2.5）
   */
  const searchSourceLabel = (hit: KbSearchRowHit): string => {
    if (hit.chunkKind === 'section') {
      return hit.sectionKind ? t(`resume.kind.${hit.sectionKind}`) : t('kb.chunkSection');
    }
    const entity = entities.find((item) => item.entityId === hit.chunkId);
    return entity ? `${t('kb.chunkEntity')} · ${t(KIND_LABEL_KEY[entity.kind])}` : t('kb.chunkEntity');
  };

  /** 本次检索的向量腿状态（还没检索过时是 `undefined`，界面那一栏整个不出现）。 */
  const vectorStatus = searchResult?.vectorStatus;
  /**
   * 本次检索的向量腿那句提示（spec 4.3-08 的判据半边：三种降级都得让用户读出来是哪种）。
   * `not_attempted` 也给 `null`——那种空态正在说「这句话切不出词」，再补一句「没做语义增强」是噪声。
   */
  const vectorStatusHint =
    vectorStatus === undefined || vectorStatus === 'not_attempted' ? null : t(VECTOR_STATUS_LABEL_KEY[vectorStatus]);

  /**
   * 渲染一行实体卡片（含展开态）。
   * @param entity 实体读数
   * @param depth 缩进层级（根为 0，下属为 1）
   */
  const renderRow = (entity: KbEntityRowView, depth: number) => {
    const isDerived = entity.sourceDocId !== null;
    const expanded = expandedId === entity.entityId;
    return (
      <li
        key={entity.entityId}
        data-kb-row={entity.entityId}
        data-kb-kind={entity.kind}
        data-kb-source={entity.sourceDocId ?? 'manual'}
        className={`flex flex-col gap-2 rounded-md border border-slate-800 bg-slate-900/40 p-3 ${
          depth > 0 ? 'ml-6' : ''
        }`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-300">
            {t(KIND_LABEL_KEY[entity.kind])}
          </span>
          <span className="text-sm text-slate-200">{primaryTextOf(entity)}</span>
          <span className="text-xs text-slate-500" data-kb-entity-id={entity.entityId}>
            {entity.entityId}
          </span>
        </div>
        <p className="text-xs text-slate-500">
          {isDerived ? t('kb.derivedFrom', { docId: entity.sourceDocId ?? '' }) : t('kb.manualEntity')}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-kb-action="evidence"
            onClick={() =>
              expanded ? setExpandedId(undefined) : lookUpEvidence(primaryTextOf(entity), entity.entityId)
            }
            className="flex items-center gap-1 rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
          >
            <Search className="h-3 w-3" />
            {t('kb.evidence')}
          </button>
          {!isDerived && (
            <>
              <button
                type="button"
                data-kb-action="edit"
                onClick={() => openEditor(entity)}
                className="flex items-center gap-1 rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
              >
                <Pencil className="h-3 w-3" />
                {t('kb.edit')}
              </button>
              <button
                type="button"
                data-kb-action="delete"
                onClick={() => removeEntity(entity.entityId)}
                disabled={busy !== undefined}
                className="flex items-center gap-1 rounded border border-rose-900 px-2 py-1 text-xs text-rose-300 hover:bg-rose-950/40"
              >
                <Trash2 className="h-3 w-3" />
                {t('kb.delete')}
              </button>
            </>
          )}
        </div>
        {expanded && (
          <div data-kb-evidence={entity.entityId} className="flex flex-col gap-1 border-t border-slate-800 pt-2">
            {evidence.length === 0 ? (
              <p className="text-xs text-slate-500">{t('kb.evidenceEmpty')}</p>
            ) : (
              evidence.map((hit) => (
                <p key={hit.entityId} data-kb-hit={hit.entityId} className="text-xs text-slate-400">
                  {t(KIND_LABEL_KEY[hit.kind])} · {hit.entityId} ·{' '}
                  <span className="text-slate-300">{t(REASON_LABEL_KEY[hit.reason])}</span> · {hit.score.toFixed(2)} ·{' '}
                  {hit.matchedTokens.join(' / ')}
                </p>
              ))
            )}
            <p className="text-xs text-slate-600">
              {t('kb.updatedAt', { time: new Date(entity.updatedAt).toISOString() })}
            </p>
          </div>
        )}
      </li>
    );
  };

  return (
    <div data-testid="kb-panel" className="flex flex-col gap-4 rounded-lg border border-slate-800 bg-slate-950/60 p-4">
      <div className="flex items-center gap-2">
        <Database className="h-4 w-4 text-slate-300" />
        <h2 className="text-sm font-semibold text-slate-200">{t('kb.heading')}</h2>
      </div>
      <p className="text-xs leading-relaxed text-slate-500">{t('kb.hint')}</p>

      <div className="flex flex-wrap items-center gap-2">
        <input
          data-kb-field="docId"
          value={docId}
          onChange={(event) => setDocId(event.target.value)}
          placeholder={t('kb.docIdPlaceholder')}
          className="min-w-40 flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200"
        />
        <button
          type="button"
          data-kb-action="sync"
          onClick={syncFromDoc}
          disabled={busy !== undefined || docId.trim() === ''}
          className="flex items-center gap-1 rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-40"
        >
          <RefreshCw className="h-3 w-3" />
          {t('kb.sync')}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          data-kb-field="claim"
          value={claim}
          onChange={(event) => setClaim(event.target.value)}
          placeholder={t('kb.claimPlaceholder')}
          className="min-w-40 flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200"
        />
        <button
          type="button"
          data-kb-action="lookup"
          onClick={() => lookUpEvidence(claim.trim())}
          disabled={busy !== undefined || claim.trim() === ''}
          className="flex items-center gap-1 rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-40"
        >
          <Search className="h-3 w-3" />
          {t('kb.evidence')}
        </button>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <input
            data-kb-field="search"
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            placeholder={t('kb.searchPlaceholder')}
            className="min-w-40 flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200"
          />
          <button
            type="button"
            data-kb-action="search"
            onClick={runSearch}
            disabled={busy !== undefined || searchText.trim() === ''}
            className="flex items-center gap-1 rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-40"
          >
            <Search className="h-3 w-3" />
            {t('kb.search')}
          </button>
        </div>
        {/* 向量腿的当次状态单独一行（spec 4.3-08）：命中数不变，但「只有词面结果」这件事必须读得出原因。 */}
        {vectorStatusHint !== null && (
          <p data-kb-search="vector-status" className="text-xs leading-relaxed text-slate-500">
            {vectorStatusHint}
          </p>
        )}
        {searchResult &&
          (searchResult.status === 'no_query_tokens' ? (
            // 确定空态之一：这句查询里切不出可检索的词（全是标点或空白）。不返回随机结果，也不报「检索失败」。
            <p data-kb-search="no_tokens" className="text-xs leading-relaxed text-slate-500">
              {t('kb.searchNoTokensHint')}
            </p>
          ) : searchResult.hits.length === 0 ? (
            // 确定空态之二：库里确实没有沾边的内容——建议给出下一步（先同步、或换个更短的关键词、或补一条实体）。
            <p data-kb-search="empty" className="text-xs leading-relaxed text-slate-500">
              {t('kb.searchNoHitsHint')}
            </p>
          ) : (
            <>
              <p data-kb-search="ok" className="text-xs text-slate-500">
                {t('kb.searchTokens', { tokens: searchResult.queryTokens.join(' / ') })}
              </p>
              <ul className="flex flex-col gap-1">
                {searchResult.hits.map((hit) => (
                  <li key={hit.chunkId} data-kb-search-hit={hit.chunkId} className="text-xs text-slate-400">
                    <span className="text-slate-300">{searchSourceLabel(hit)}</span> · {hit.text} ·{' '}
                    <span className="text-slate-300">
                      {hit.reasons.map((reason) => t(SEARCH_REASON_LABEL_KEY[reason])).join(' / ')}
                    </span>{' '}
                    · {hit.score.toFixed(2)} · {hit.matchedTokens.join(' / ')}
                  </li>
                ))}
              </ul>
            </>
          ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          data-kb-field="backupPath"
          value={backupPath}
          onChange={(event) => setBackupPath(event.target.value)}
          placeholder={t('kb.backupPathPlaceholder')}
          className="min-w-40 flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200"
        />
        <button
          type="button"
          data-kb-action="export"
          onClick={exportBackup}
          disabled={busy !== undefined || backupPath.trim() === ''}
          className="flex items-center gap-1 rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-40"
        >
          <Download className="h-3 w-3" />
          {t('kb.export')}
        </button>
        <button
          type="button"
          data-kb-action="import"
          onClick={importBackup}
          disabled={busy !== undefined || backupPath.trim() === ''}
          className="flex items-center gap-1 rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-40"
        >
          <Upload className="h-3 w-3" />
          {t('kb.import')}
        </button>
        <select
          data-kb-field="importMode"
          value={importMode}
          onChange={(event) => setImportMode(event.target.value as KbImportModeView)}
          className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-300"
        >
          <option value="skip">{t('kb.modeSkip')}</option>
          <option value="overwrite">{t('kb.modeOverwrite')}</option>
        </select>
      </div>

      {entities.length === 0 ? (
        <p data-kb-empty className="text-xs text-slate-500">
          {t('kb.empty')}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {roots.map((entity) => (
            <Fragment key={entity.entityId}>
              {renderRow(entity, 0)}
              {childrenOf(entity.entityId).map((child) => renderRow(child, 1))}
            </Fragment>
          ))}
          {/* 归属指向已删实体的行不该出现（4.2-c 的 detach 保证），这里兜底显示顶层，避免界面把行数少算掉 */}
          {entities
            .filter((entity) => entity.parentId !== null && !entities.some((p) => p.entityId === entity.parentId))
            .map((entity) => renderRow(entity, 0))}
        </ul>
      )}

      <div className="flex flex-col gap-2 border-t border-slate-800 pt-2">
        <button
          type="button"
          data-kb-action="new"
          onClick={() => openEditor()}
          disabled={busy !== undefined}
          className="flex items-center gap-1 self-start rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-40"
        >
          <Plus className="h-3 w-3" />
          {t('kb.create')}
        </button>
        {editing && (
          <div className="flex flex-col gap-2" data-kb-editor={editing.entityId ?? 'new'}>
            <select
              data-kb-field="editKind"
              value={editing.kind}
              onChange={(event) => setEditing({ ...editing, kind: event.target.value as KbEntityKindView })}
              disabled={editing.entityId !== null}
              className="self-start rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-300 disabled:opacity-40"
            >
              {(Object.keys(KIND_LABEL_KEY) as KbEntityKindView[]).map((kind) => (
                <option key={kind} value={kind}>
                  {t(KIND_LABEL_KEY[kind])}
                </option>
              ))}
            </select>
            <textarea
              data-kb-field="editPayload"
              rows={4}
              value={editing.lines}
              onChange={(event) => setEditing({ ...editing, lines: event.target.value })}
              className="rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-xs text-slate-200"
            />
            <p className="text-xs text-slate-500">{t('kb.payloadHint')}</p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-kb-action="save"
                onClick={saveDraft}
                disabled={busy !== undefined}
                className="rounded border border-emerald-900 px-2 py-1 text-xs text-emerald-300 hover:bg-emerald-950/40 disabled:opacity-40"
              >
                {t('kb.save')}
              </button>
              <button
                type="button"
                data-kb-action="cancel"
                onClick={() => setEditing(undefined)}
                className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
              >
                {t('kb.cancel')}
              </button>
            </div>
          </div>
        )}
      </div>

      <p data-kb-notice className="min-h-4 text-xs text-slate-400">
        {notice ?? ''}
      </p>
    </div>
  );
}
