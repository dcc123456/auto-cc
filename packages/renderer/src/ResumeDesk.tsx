import { Eye, FileText, FolderOpen, Maximize2, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AppErrorPayload,
  BridgeReply,
  GenerationRunRowView,
  ImportProvenanceRowView,
  PendingImportRowView,
  ResumeDocSummaryView,
  ResumeLocaleView,
  ResumeTemplateSummaryView,
} from '@auto-cc/shared';
import { handOffDocumentToCompanion } from './companion-handoff';
import { formatClock } from './format';
import { ResumeFormPage } from './ResumeFormPage';
import { ResumeGeneratePage } from './ResumeGeneratePage';
import { ResumePreviewModal } from './ResumePreviewModal';
import { Banner, DeskButton, DeskSelect, Tag } from './ui/controls';
import { DeskExplainer } from './ui/disclosure';
import { Modal } from './ui/overlays';
import { useBridgeAction } from './useBridgeAction';
import { useViewTrail } from './viewTrail';

/** 一次导入最多吃多少份文件：系统面板不限制，渲染层自己兜底，避免一次把解析与入库排到天荒地老。 */
const MAX_IMPORT_FILES = 20;

/** 待确认标记的种类 → 文案键（与 4.1-04 的五类一一对应，界面只转述）。 */
const ISSUE_LABEL_KEY = {
  'text-too-short': 'resume.issueTextTooShort',
  'missing-field': 'resume.issueMissingField',
  'unparsable-field': 'resume.issueUnparsableField',
  'sensitive-redacted': 'resume.issueSensitiveRedacted',
  'unknown-section': 'resume.issueUnknownSection',
} as const;

/** 导入源格式 → 文案键（格式由主进程按魔数判定，界面只转述读数）。 */
const FORMAT_LABEL_KEY = {
  pdf: 'resume.formatPdf',
  docx: 'resume.formatDocx',
  markdown: 'resume.formatMarkdown',
  text: 'resume.formatText',
} as const;

/** 一份文件导入失败的读数（文件名只用于给人看，完整路径不落界面）。 */
interface ImportFailure {
  file: string;
  error: AppErrorPayload;
}

/** 一批导入的聚合回执：新入库 / 重复 / 扫描件 / 失败 / 被上限截掉的份数。 */
interface ImportBatchResult {
  imported: number;
  duplicate: number;
  scanned: number;
  failures: ImportFailure[];
  truncated: number;
}

/** 简历屏当前挂的子页面：列表 / 一份简历的表单 / 按 JD 生成。 */
type ResumePage = { kind: 'list' } | { kind: 'form'; docId: string } | { kind: 'generate'; docId: string };

/**
 * 取一条本机路径的**末段名字**（两个分隔符都吃：mac 的 `/` 与 Windows 的 `\`）。
 * @param filePath 人选中的那条绝对路径
 * @returns 文件名那一段；末尾就是分隔符这类极端形状回空串
 */
function baseNameOf(filePath: string): string {
  const segments = filePath.split(/[/\\]/);
  return segments[segments.length - 1] ?? '';
}

/**
 * 简历屏（spec 9.3-01…05）：一份简洁的简历列表 + 三个整屏/弹窗子页面。
 *
 * 列表只回答「我有哪几份简历、下一步点哪颗键」；复杂的表单与生成各自搬到独立子页面，
 * 预览走弹窗。编辑统一交给 Office-cc，页内不再有 PDF 查看、快照对照、开发夹具或知识库面板。
 *
 * 状态归属：本组件持有清单、来路、待确认、出纸语言与当前子页面；表单/生成/预览都只吃 props。
 * 所有读数来自 `window.autoCC` 的既有白名单调用，界面不自己算库里的真相。
 */
export function ResumeDesk() {
  const { t } = useTranslation();
  const bridge = window.autoCC;
  const [locale, setLocale] = useState<ResumeLocaleView>('zh-CN');
  const [docs, setDocs] = useState<ResumeDocSummaryView[]>([]);
  const [provenance, setProvenance] = useState<ImportProvenanceRowView[]>([]);
  const [pending, setPending] = useState<PendingImportRowView[]>([]);
  const [templates, setTemplates] = useState<ResumeTemplateSummaryView[]>([]);
  const [templateId, setTemplateId] = useState('classic');
  const [lastImportBatch, setLastImportBatch] = useState<ImportBatchResult>();
  const [importError, setImportError] = useState<AppErrorPayload>();
  const [pendingDelete, setPendingDelete] = useState<string>();
  const [deleteError, setDeleteError] = useState<AppErrorPayload>();
  const [page, setPage] = useState<ResumePage>({ kind: 'list' });
  const [previewDocId, setPreviewDocId] = useState<string>();
  const [previewHtml, setPreviewHtml] = useState<string>();
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string>();
  const [generatePreview, setGeneratePreview] = useState<GenerationRunRowView>();
  /** 预览请求的序列号：换文档/换语言时丢掉上一趟的迟到响应，避免旧纸盖在新身份上。 */
  const previewSeqRef = useRef(0);
  /** 当前母版清单的 ref：view trail 跳进来时要立刻知道默认生成哪一份，但不想让 docGroups 的后续变化重置页面。 */
  const mastersRef = useRef<ResumeDocSummaryView[]>([]);
  const trail = useViewTrail();

  /**
   * 重读库里的简历清单。
   * 清单是列表页与生成页共同的事实来源；任何导入/删除/接受变体之后都由 `read()` 统一重读。
   */
  const refreshDocs = useCallback(async () => {
    const reply = await bridge?.resume['doc.list']();
    if (reply?.ok) setDocs(reply.value);
  }, [bridge]);

  /**
   * 重读待确认清单、每份简历的来路与库内清单。
   * 界面不猜主进程当下的状态，所以每个动作结束后都走这一条。
   */
  const read = useCallback(async () => {
    const [pendingReply, provenanceReply] = await Promise.all([
      bridge?.resume['parse.pending'](),
      bridge?.resume['parse.provenance'](),
    ]);
    if (pendingReply?.ok) setPending(pendingReply.value);
    if (provenanceReply?.ok) setProvenance(provenanceReply.value);
    await refreshDocs();
  }, [bridge, refreshDocs]);

  // 进门先问模板偏好（预览与 Office-cc 出纸用），文档清单与会话读数并行读。
  useEffect(() => {
    void (async () => {
      const [list, pref] = await Promise.all([
        bridge?.resume['export.templates'](),
        bridge?.resume['export.preference'](),
      ]);
      if (list?.ok) setTemplates(list.value);
      if (pref?.ok) setTemplateId(pref.value.templateId);
    })();
    void read();
  }, [bridge, read]);

  // 视图是 hidden 显隐而不是卸载；每次重新可见都重读，别的视图里导入的简历才会立刻出现。
  useEffect(() => {
    const host = document.querySelector<HTMLElement>('[data-view-scroll="resume"]');
    if (!host || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void read();
      },
      { threshold: 0 },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, [read]);

  const { busy, notice, noticeTone, run, setNotice } = useBridgeAction(read);

  /** 库被改过就把提议态丢掉：基线已变，留着旧建议只会诱人把过期文字填进格子。 */
  useEffect(() => {
    if (!bridge) return;
    return bridge.on('kb/entities-changed', () => setGeneratePreview(undefined));
  }, [bridge]);

  /** 母版在前、各自的变体紧跟其下；母版已删而变体还在的行排在末尾，仍可预览/删除。 */
  const docGroups = useMemo(() => {
    const masters = docs.filter((doc) => doc.parentDocId === null);
    const rows: ResumeDocSummaryView[] = [];
    for (const master of masters) {
      rows.push(master);
      rows.push(...docs.filter((doc) => doc.parentDocId === master.id));
    }
    const masterIds = new Set(masters.map((master) => master.id));
    rows.push(...docs.filter((doc) => doc.parentDocId !== null && !masterIds.has(doc.parentDocId)));
    return { rows, masters };
  }, [docs]);

  // 让 view trail 的 effect 能拿到此刻的母版，而不把 docGroups 写进依赖（否则清单一刷新就把子页面重置）。
  useEffect(() => {
    mastersRef.current = docGroups.masters;
  }, [docGroups]);

  /** 岗位页跳进来（09 稿形态⑥）：直接落在生成子页面，JD 正文由 `GeneratePanel` 自己消费。 */
  const trailRequestId = trail?.targetView === 'resume' ? trail.requestId : undefined;
  useEffect(() => {
    if (trailRequestId === undefined) return;
    setPage({ kind: 'generate', docId: mastersRef.current[0]?.id ?? '' });
  }, [trailRequestId]);

  /** 那一跳被收起（人手动切视图或按面包屑返回）时回列表；否则再点「简历」还会停在生成页上。 */
  const previousTrailRequestIdRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    const previous = previousTrailRequestIdRef.current;
    previousTrailRequestIdRef.current = trailRequestId;
    if (previous !== undefined && trailRequestId === undefined) setPage({ kind: 'list' });
  }, [trailRequestId]);

  // 表单页指向的那一份被删掉时退回列表，避免挂着一张已死身份的空页。
  useEffect(() => {
    if (page.kind !== 'form') return;
    if (docs.some((doc) => doc.id === page.docId)) return;
    setPage({ kind: 'list' });
  }, [docs, page]);

  /**
   * 一份候选的出处那一行：文件名、导入时刻与字数；没有来路行就明写「没有导入记录」。
   * @param targetDocId 这一行所属的候选 id
   * @returns 摆在姓名下面的一句小字
   */
  const provenanceLine = (targetDocId: string): string => {
    const line = provenance.find((row) => row.docId === targetDocId);
    if (line === undefined) return t('resume.provenanceNoImport');
    const time = new Date(line.importedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    return line.sourceName === null
      ? t('resume.provenanceNoName', { time, chars: line.textLength })
      : t('resume.provenanceFile', { file: line.sourceName, time, chars: line.textLength });
  };

  /**
   * 变体下面那行小字：为哪段 JD 生成、生成于何时。
   * @param variant 库里的变体行
   * @returns 已翻译的一行字；标题没记过时明写「未标明 JD」
   */
  const variantLine = (variant: ResumeDocSummaryView): string =>
    t('resume.docVariantLine', {
      jd: variant.jdLabel ?? t('resume.docVariantNoLabel'),
      time: formatClock(variant.updatedAt, ''),
    });

  /** 待确认按 docId 索引：卡片上的徽标与顶部清单共用这一份读数。 */
  const pendingByDoc = useMemo(() => {
    const index = new Map<string, PendingImportRowView>();
    for (const row of pending) index.set(row.docId, row);
    return index;
  }, [pending]);

  const deleteTarget = docs.find((doc) => doc.id === pendingDelete);
  const deleteTargetLabel = deleteTarget ? (deleteTarget.name ?? t('resume.pendingUnnamed')) : undefined;
  const busyReason = busy !== undefined ? 'ACTION_BUSY' : undefined;
  /**
   * 原因码 → 人话（按不动必须说得出为什么）。
   * @param code 该按钮当下的原因码；可用时为 undefined
   */
  const reasonLabel = (code?: string): string | undefined =>
    code === undefined ? undefined : t(`resume.reason.${code}`);

  /**
   * 逐份导入选中的文件，聚合成一条回执。
   * @param paths 系统面板回传的绝对路径列表（已按上限截断）
   * @returns 新入库/重复/扫描件/失败四项计数与被上限截掉的份数
   */
  const importSelectedFiles = async (paths: string[]): Promise<ImportBatchResult> => {
    const acceptedPaths = paths.slice(0, MAX_IMPORT_FILES);
    const truncated = paths.length - acceptedPaths.length;
    let imported = 0;
    let duplicate = 0;
    let scanned = 0;
    const failures: ImportFailure[] = [];
    if (bridge === undefined) {
      return { imported, duplicate, scanned, failures, truncated };
    }
    for (const filePath of acceptedPaths) {
      const reply = await bridge.resume['parse.fromFile'](filePath);
      if (!reply.ok) {
        failures.push({ file: baseNameOf(filePath), error: reply.error });
        continue;
      }
      if (reply.value.status === 'scanned') scanned += 1;
      else if (reply.value.isNew) imported += 1;
      else duplicate += 1;
    }
    return { imported, duplicate, scanned, failures, truncated };
  };

  /**
   * 多选导入（spec 9.3-01）：系统面板可一次选多份，逐份走 `resume.parse.fromFile`。
   * 全部失败时上浮结构化错误；部分失败时仍算完成，失败明细由下面的 Banner 逐条列出。
   */
  const pickAndImport = () => {
    let batch: ImportBatchResult | undefined;
    void run(
      t('resume.importMany'),
      () => {
        if (!bridge) return undefined;
        return (async (): Promise<BridgeReply<ImportBatchResult | undefined>> => {
          const picked = await bridge.shell.selectFile({
            title: t('resume.pickerTitle'),
            filters: [
              { name: t('resume.pickerFilterResume'), extensions: ['pdf', 'docx', 'md', 'txt'] },
              { name: t('resume.pickerFilterAll'), extensions: ['*'] },
            ],
            multiple: true,
          });
          if (!picked.ok) return { ok: false, error: picked.error };
          if (picked.value.filePaths.length === 0) return { ok: true, value: undefined };
          const result = await importSelectedFiles(picked.value.filePaths);
          batch = result;
          const accepted = result.imported + result.duplicate + result.scanned;
          if (accepted === 0 && result.failures.length > 0) {
            const first = result.failures[0]!;
            return { ok: false, error: first.error };
          }
          return { ok: true, value: result };
        })();
      },
      {
        apply: (value) => {
          setImportError(undefined);
          if (value !== undefined) setLastImportBatch(value);
        },
        describe: (value) =>
          value === undefined
            ? t('resume.pickerCanceled')
            : t('resume.importBatchDone', {
                imported: value.imported,
                duplicate: value.duplicate,
                scanned: value.scanned,
              }),
        onError: setImportError,
      },
    ).then(() => {
      if (batch === undefined) return;
      setLastImportBatch(batch);
      if (batch.failures.length > 0) {
        setNotice(t('resume.importBatchPartial', { failed: batch.failures.length }), 'seal');
      }
    });
  };

  /** 预览请求：先把上一张纸与在途请求作废，再由下面那条 effect 去供料（换语言会重来一趟）。 */
  const openPreview = (targetDocId: string) => {
    previewSeqRef.current += 1;
    setPreviewHtml(undefined);
    setPreviewError(undefined);
    setPreviewLoading(true);
    setPreviewDocId(targetDocId);
  };

  /** 关闭预览并作废在途请求，避免关掉之后又弹回一张旧纸。 */
  const closePreview = () => {
    previewSeqRef.current += 1;
    setPreviewDocId(undefined);
    setPreviewHtml(undefined);
    setPreviewError(undefined);
    setPreviewLoading(false);
  };

  // 预览供料：同一份打印 HTML 源（`resume.export.preview`），换文档/语言/样式就重来一趟。
  useEffect(() => {
    if (previewDocId === undefined) return;
    if (bridge === undefined) {
      setPreviewLoading(false);
      setPreviewError(t('action.noBridge'));
      return;
    }
    const seq = previewSeqRef.current + 1;
    previewSeqRef.current = seq;
    setPreviewHtml(undefined);
    setPreviewError(undefined);
    setPreviewLoading(true);
    void (async () => {
      const reply = await bridge.resume['export.preview'](previewDocId, templateId, locale);
      if (seq !== previewSeqRef.current) return;
      setPreviewLoading(false);
      if (reply.ok) setPreviewHtml(reply.value);
      else setPreviewError(reply.error.message);
    })();
  }, [previewDocId, templateId, locale, bridge, t]);

  /**
   * 把一份简历交给 Office-cc：先出 PDF，成功后才会打开伴生应用。
   * @param targetDocId 要交出去的那一份
   */
  const handOff = (targetDocId: string) =>
    void run(
      t('desk.resume.editEnter'),
      () => {
        if (bridge === undefined) return undefined;
        return handOffDocumentToCompanion(
          {
            toPdf: (target, template, docLocale) => bridge.resume['export.toPdf'](target, template, docLocale),
            open: (filePath) => bridge.shell.openInCompanionEditor(filePath),
          },
          targetDocId,
          templateId,
          locale,
        );
      },
      {
        describe: (value) =>
          t('desk.resume.handoffDone', { path: value.openedPath, pages: value.pages, bytes: value.bytes }),
        apply: () => closePreview(),
      },
    );

  /**
   * 删除一份简历；失败时保留行并显示原因，成功时重读清单。
   * @param targetDocId 确认框里那一份
   */
  const deleteDoc = (targetDocId: string) =>
    void run(t('resume.delete'), () => bridge?.kb['profile.removeDoc'](targetDocId), {
      onError: (error) => setDeleteError(error),
      describe: (value) =>
        t('resume.deleted', {
          entities: value.entities,
          chunks: value.chunks,
          snapshots: value.snapshots,
          imports: value.imports,
        }),
      apply: () => {
        setDeleteError(undefined);
        if (page.kind === 'form' && page.docId === targetDocId) setPage({ kind: 'list' });
        if (previewDocId === targetDocId) closePreview();
      },
    });

  /**
   * 打开删除确认；确认框关掉后 `pendingDelete` 会清空，人手一抖按不到第二刀。
   * @param targetDocId 要删的那一份
   */
  const askDelete = (targetDocId: string) => {
    setDeleteError(undefined);
    setPendingDelete(targetDocId);
  };

  /** 打开生成子页面；省略 docId 时默认拿第一份母版。 */
  const openGenerate = (targetDocId?: string) =>
    setPage({ kind: 'generate', docId: targetDocId ?? docGroups.masters[0]?.id ?? '' });

  const formDoc = page.kind === 'form' ? docs.find((doc) => doc.id === page.docId) : undefined;
  const generateDocId = page.kind === 'generate' ? page.docId || docGroups.masters[0]?.id || '' : '';
  const previewDoc = previewDocId === undefined ? undefined : docs.find((doc) => doc.id === previewDocId);
  const previewDocLabel = previewDoc?.name ?? (previewDocId === undefined ? undefined : t('resume.pendingUnnamed'));
  const templateName = templates.find((template) => template.id === templateId)?.name;

  return (
    <>
      {page.kind === 'list' || (page.kind === 'form' && formDoc === undefined) ? (
        <div className="flex min-w-0 flex-col gap-3" data-testid="resume-list">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <DeskButton
              action="resume-import-many"
              variant="amber"
              busy={!!busy}
              disabled={!!busy}
              disabledReason={busyReason}
              disabledReasonLabel={reasonLabel(busyReason)}
              onClick={pickAndImport}
            >
              <FolderOpen size={13} />
              {t('resume.importMany')}
            </DeskButton>
            <DeskButton action="resume-generate-open" variant="line" compact onClick={() => openGenerate()}>
              <Sparkles size={12} />
              {t('resume.generateEntry')}
            </DeskButton>
            <label className="flex items-center gap-1 text-[11px] text-slate-400">
              {t('resume.localeLabel')}
              <DeskSelect
                action="resume-locale"
                data-testid="resume-locale"
                value={locale}
                onValueChange={(value) => setLocale(value as ResumeLocaleView)}
              >
                <option value="zh-CN">zh-CN</option>
                <option value="en">en</option>
              </DeskSelect>
            </label>
            <DeskButton
              action="refresh"
              variant="line"
              compact
              busy={!!busy}
              disabled={!!busy}
              disabledReason={busyReason}
              disabledReasonLabel={reasonLabel(busyReason)}
              onClick={() => void read()}
            >
              <RefreshCw size={12} />
              {t('resume.refresh')}
            </DeskButton>
            {templateName ? (
              <span className="text-[11px] text-slate-500" data-testid="resume-template-reading">
                {t('resume.templateReading', { template: templateName })}
              </span>
            ) : null}
          </div>

          {notice && (
            <Banner tone={noticeTone} markers={{ testid: 'resume-notice' }} className="break-all">
              {notice}
            </Banner>
          )}

          {importError && (
            <Banner tone="seal" markers={{ testid: 'resume-import-error' }} className="break-all">
              {t('resume.importError', { code: importError.code, message: importError.message })}
            </Banner>
          )}

          {deleteError && (
            <Banner tone="seal" markers={{ testid: 'resume-delete-error' }} className="break-all">
              {t('resume.deleteError', { code: deleteError.code, message: deleteError.message })}
            </Banner>
          )}

          {lastImportBatch && (
            <Banner
              tone={lastImportBatch.failures.length > 0 ? 'amber' : 'jade'}
              markers={{ testid: 'resume-import-batch' }}
              className="break-all"
            >
              <div className="w-full">
                <p className="font-semibold">{t('resume.importBatchHeading')}</p>
                <p className="mt-1">
                  {t('resume.importBatchDone', {
                    imported: lastImportBatch.imported,
                    duplicate: lastImportBatch.duplicate,
                    scanned: lastImportBatch.scanned,
                  })}
                </p>
                {lastImportBatch.truncated > 0 && (
                  <p className="mt-1">{t('resume.importBatchTruncated', { count: lastImportBatch.truncated })}</p>
                )}
                {lastImportBatch.failures.length > 0 && (
                  <ul className="mt-1 flex flex-col gap-0.5" data-testid="resume-import-failures">
                    {lastImportBatch.failures.map((failure) => (
                      <li key={`${failure.file}-${failure.error.code}`}>
                        {t('resume.importFailureRow', {
                          file: failure.file,
                          code: failure.error.code,
                          message: failure.error.message,
                        })}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Banner>
          )}

          {pending.length > 0 && (
            <DeskExplainer
              id="resume.pending-issues"
              label={t('resume.pendingCount', { count: pending.length })}
              markers={{ testid: 'resume-pending-list' }}
            >
              <ul className="space-y-2">
                {pending.map((row) => (
                  <li
                    key={row.sourceHash}
                    data-testid="resume-pending-row"
                    data-status={row.status}
                    className="rounded border border-line px-2 py-1.5"
                  >
                    <p className="text-[11px] text-slate-400">
                      {t('resume.pendingRow', {
                        name: docs.find((doc) => doc.id === row.docId)?.name ?? t('resume.pendingUnnamed'),
                        issueCount: row.issues.length,
                        time: new Date(row.updatedAt).toLocaleTimeString(),
                      })}
                      {' · '}
                      {row.status === 'scanned'
                        ? t('resume.statusScanned', { chars: row.textLength })
                        : t('resume.statusImported')}
                      {' · '}
                      {t(FORMAT_LABEL_KEY[row.format])}
                    </p>
                    <ul className="mt-1 space-y-0.5 pl-2">
                      {row.issues.map((issue, index) => (
                        <li
                          key={`${issue.code}-${issue.fieldKey ?? 'doc'}-${String(index)}`}
                          data-testid="resume-pending-issue"
                          className="flex flex-wrap items-baseline gap-1 text-[11px] text-slate-500"
                        >
                          <Tag tone="amber">{t(ISSUE_LABEL_KEY[issue.code])}</Tag>
                          <span>{issue.sectionKind ?? '-'}</span>
                          <span className="break-all">{issue.excerpt}</span>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </DeskExplainer>
          )}

          {docs.length === 0 ? (
            <p className="text-[11px] text-slate-500" data-testid="resume-empty">
              {t('resume.empty')}
            </p>
          ) : (
            <ul className="flex min-w-0 flex-col gap-2" data-testid="resume-list-items">
              {docGroups.rows.map((doc) => {
                const isVariant = doc.parentDocId !== null;
                const pendingRow = pendingByDoc.get(doc.id);
                const editDeadReason = isVariant ? 'RESUME_VARIANT_READ_ONLY' : busyReason;
                return (
                  <li
                    key={doc.id}
                    data-testid="resume-card"
                    data-doc-id={doc.id}
                    data-parent-doc-id={doc.parentDocId ?? ''}
                    data-jd-label={doc.jdLabel ?? ''}
                    className="flex min-w-0 flex-col gap-2 rounded-xl border border-line bg-ink-900/60 p-3"
                  >
                    <div className="flex min-w-0 flex-wrap items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm font-semibold text-slate-100">
                          <span className="truncate">{doc.name ?? t('resume.pendingUnnamed')}</span>
                          {isVariant && <Tag>{t('resume.docVariantTag')}</Tag>}
                          {pendingRow && (
                            <Tag tone="amber">{t('resume.pendingBadge', { count: pendingRow.issues.length })}</Tag>
                          )}
                        </p>
                        <p className="mt-0.5 truncate text-[11px] text-slate-500">
                          {isVariant ? variantLine(doc) : provenanceLine(doc.id)}
                        </p>
                        <p className="mt-0.5 text-[11px] text-slate-500" data-testid="resume-card-updated">
                          {t('resume.updatedAt', { time: formatClock(doc.updatedAt, '') })}
                        </p>
                      </div>
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <DeskButton
                          action="resume-card-edit"
                          variant="line"
                          compact
                          busy={!!busy}
                          disabled={editDeadReason !== undefined}
                          disabledReason={editDeadReason}
                          disabledReasonLabel={reasonLabel(editDeadReason)}
                          markers={{ docId: doc.id }}
                          onClick={() => setPage({ kind: 'form', docId: doc.id })}
                        >
                          <FileText size={12} />
                          {t('resume.cardEdit')}
                        </DeskButton>
                        <DeskButton
                          action="resume-card-preview"
                          variant="line"
                          compact
                          busy={!!busy}
                          disabled={!!busy}
                          disabledReason={busyReason}
                          disabledReasonLabel={reasonLabel(busyReason)}
                          markers={{ docId: doc.id }}
                          onClick={() => openPreview(doc.id)}
                        >
                          <Eye size={12} />
                          {t('resume.cardPreview')}
                        </DeskButton>
                        {!isVariant && (
                          <DeskButton
                            action="resume-card-generate"
                            variant="line"
                            compact
                            busy={!!busy}
                            disabled={!!busy}
                            disabledReason={busyReason}
                            disabledReasonLabel={reasonLabel(busyReason)}
                            markers={{ docId: doc.id }}
                            onClick={() => openGenerate(doc.id)}
                          >
                            <Sparkles size={12} />
                            {t('resume.cardGenerate')}
                          </DeskButton>
                        )}
                        <DeskButton
                          action="resume-card-office"
                          variant="line"
                          compact
                          busy={!!busy}
                          disabled={!!busy}
                          disabledReason={busyReason}
                          disabledReasonLabel={reasonLabel(busyReason)}
                          markers={{ docId: doc.id }}
                          onClick={() => handOff(doc.id)}
                        >
                          <Maximize2 size={12} />
                          {t('resume.cardOffice')}
                        </DeskButton>
                        <DeskButton
                          action="resume-card-delete"
                          variant="ghost"
                          compact
                          busy={!!busy}
                          disabled={!!busy}
                          disabledReason={busyReason}
                          disabledReasonLabel={reasonLabel(busyReason)}
                          markers={{ docId: doc.id }}
                          onClick={() => askDelete(doc.id)}
                        >
                          <Trash2 size={12} />
                          {t('resume.delete')}
                        </DeskButton>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}

      {page.kind === 'form' && formDoc !== undefined ? (
        <ResumeFormPage
          doc={formDoc}
          isVariant={formDoc.parentDocId !== null}
          suggestions={generatePreview?.rewrites}
          onBack={() => setPage({ kind: 'list' })}
          onPreview={() => openPreview(formDoc.id)}
          onHandoff={() => handOff(formDoc.id)}
          busy={!!busy}
          busyReason={busyReason}
          busyReasonLabel={reasonLabel(busyReason)}
        />
      ) : null}

      {page.kind === 'generate' ? (
        <ResumeGeneratePage
          docs={docGroups.masters}
          docId={generateDocId}
          onDocIdChange={(nextDocId) => setPage({ kind: 'generate', docId: nextDocId })}
          refreshDocs={refreshDocs}
          onAccepted={() => setPage({ kind: 'list' })}
          onPreview={setGeneratePreview}
          onBack={() => setPage({ kind: 'list' })}
        />
      ) : null}

      <ResumePreviewModal
        open={previewDocId !== undefined}
        docLabel={previewDocLabel}
        html={previewHtml}
        loading={previewLoading}
        error={previewError}
        locale={locale}
        onLocaleChange={setLocale}
        onClose={closePreview}
        onHandoff={() => {
          if (previewDocId !== undefined) handOff(previewDocId);
        }}
        busy={!!busy}
        busyReason={busyReason}
        busyReasonLabel={reasonLabel(busyReason)}
      />

      <Modal
        action="resume-delete"
        open={deleteTargetLabel !== undefined}
        title={t('resume.deleteTitle')}
        onClose={() => setPendingDelete(undefined)}
        width="480"
        tone="seal"
        dismissOnScrim={false}
        testId="resume-delete-modal"
        markers={{ docId: pendingDelete ?? '' }}
        footer={
          <>
            <DeskButton
              action="resume-delete-cancel"
              variant="line"
              compact
              onClick={() => setPendingDelete(undefined)}
            >
              {t('resume.deleteCancel')}
            </DeskButton>
            <DeskButton
              action="resume-delete-confirm"
              variant="seal"
              compact
              busy={busy === t('resume.delete')}
              disabled={!!busy}
              disabledReason={busyReason}
              disabledReasonLabel={reasonLabel(busyReason)}
              onClick={() => {
                const target = pendingDelete;
                setPendingDelete(undefined);
                if (target !== undefined) deleteDoc(target);
              }}
            >
              {t('resume.deleteConfirm')}
            </DeskButton>
          </>
        }
      >
        <div className="flex min-w-0 flex-col gap-2">
          <p>{t('resume.deleteBody', { doc: deleteTargetLabel ?? '' })}</p>
          {deleteError && (
            <Banner tone="seal" markers={{ testid: 'resume-delete-error' }} className="break-all">
              {t('resume.deleteError', { code: deleteError.code, message: deleteError.message })}
            </Banner>
          )}
          <ul className="list-disc pl-4 text-slate-300">
            <li>{t('resume.deleteRemoves')}</li>
            <li>{t('resume.deleteKept')}</li>
          </ul>
        </div>
      </Modal>
    </>
  );
}
