import {
  Ban,
  BookmarkPlus,
  Eye,
  FolderOpen,
  FileDown,
  FileText,
  GitCompareArrows,
  History,
  ListChecks,
  Pencil,
  RefreshCw,
  SlidersHorizontal,
  Upload,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AppErrorPayload,
  ExportReceiptView,
  ImportReceiptView,
  PendingImportRowView,
  ResumeDocSummaryView,
  ResumeLocaleView,
  ResumeTemplateSummaryView,
  SnapshotDiffView,
  SnapshotMetaView,
} from '@auto-cc/shared';
import { pushDeskToast } from './deskToast';
import { PdfEditPanel } from './PdfEditPanel';
import { ResumeEditor } from './ResumeEditor';
import { Banner, DeskButton, DeskField, DeskSelect, Tag } from './ui/controls';
import { Drawer } from './ui/overlays';
import { useBridgeAction } from './useBridgeAction';

/** 故意不存在的文档 id：供「注入失败导出」按钮触发主进程返回 `AppErrorPayload`（spec 3.3-11 的验证入口）。 */
const FAILURE_DOC_ID = 'resume-fail-injected';

/** 变更类型 → 文案键（`added`/`removed`/`modified` 三种在界面上的说法不同，颜色也不同）。 */
const CHANGE_LABEL_KEY = {
  added: 'resume.changeAdded',
  removed: 'resume.changeRemoved',
  modified: 'resume.changeModified',
} as const;

/**
 * 变更类型 → 芯片语气档，照稿 `docs/design/ui-drafts/09-dialogs.html` 形态④ 4-A 那一栏：
 * 新增涂青玉、删除涂朱砂、改述走中性回执档（稿上那一格就是不带语气的 `.tag`）。
 * 这三档说的是"这一条是加/删/改"，不是"办好了/有风险"——`Tag` 的语气档在这里借的是稿上同一张脸，
 * 判定语义仍由主进程的 diff 给出，界面不改判（AGENTS.md §2.5）。
 */
const CHANGE_TONE: Record<keyof typeof CHANGE_LABEL_KEY, 'jade' | 'seal' | undefined> = {
  added: 'jade',
  removed: 'seal',
  modified: undefined,
};

/** 待确认标记的种类 → 文案键（五种标记在 4.1-04 的清单里各有一句人话，界面按它分列）。 */
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

/**
 * 简历生成轨自测面板（spec 3.3-01 / 04 / 05 / 09 / 10 + 4.1-04 / 05 / 06 / 07 的界面化身）：
 * 「导入真实文件 → 载入固定内容 → iframe 预览 → 导出 PDF」把「原文 → 脱敏文档 → 同一份打印 HTML → PDF」
 * 这条链摆到界面上，让 harness 能在同一张截图里取到待确认清单、错误态与回执证据（AGENTS.md §7.1）。
 *
 * 只转述主进程读数：预览 HTML 与导出用的是**同一份** `resume.export` 产物（3.3-01「预览即导出所见」在界面上的体现），
 * 回执里的页数 / 字节 / 路径全部来自 `toPdf`，导入回执里的字段数与待确认标记全部来自 `resume.parse`，界面不自己算（AGENTS.md §2.5）。
 * 渲染层没有读文件的通道，所以导入入口是一行绝对路径输入框，而不是原生文件选择器（见 bridge.ts 的白名单注释）。
 * 编辑轨（3.5）之前没有录入入口，故用 `seedDemo` 喂一份虚构内容做端到端种子（3.3-10）。
 */
export function ResumePanel() {
  const { t } = useTranslation();
  const [locale, setLocale] = useState<ResumeLocaleView>('zh-CN');
  const [previewHtml, setPreviewHtml] = useState<string>();
  const [receipt, setReceipt] = useState<ExportReceiptView>();
  const [snapshots, setSnapshots] = useState<SnapshotMetaView[]>([]);
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [diff, setDiff] = useState<SnapshotDiffView>();
  /**
   * 快照历史/版本对照抽屉的开合（09 稿形态④ 4-A：对照要"两边同时看"，所以它是一只从右栏滑出的抽屉，
   * 而不是压在面板底下的一截长条）。只记开合，数据仍由 `snapshot.list` / `snapshot.diff` 现读，
   * 抽屉里不存第二份事实（§2.5）。
   */
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
  const [importPath, setImportPath] = useState('');
  /**
   * 面板当下正在操作的那份文档 id。
   *
   * 它取代了原先"必须先按『载入示例』"这一道门：那份门把预览、导出、快照、编辑器四颗按钮全压在
   * 一份虚构种子文档上，人真导入的简历反而一颗都点不动（禁用态的成因）。现在它的来源有三条——
   * 导入回执、待确认清单里的已导入行、以及示例种子，按"最近一次成功"落定。
   */
  const [docId, setDocId] = useState<string>();
  /** 库里的候选（只到摘要一层：id / 姓名 / 最后改动时刻），供上面那栏「当前简历」摆出来。 */
  const [docs, setDocs] = useState<ResumeDocSummaryView[]>([]);
  /** 可摆的模板清单与当前选择（3.2-03：数据源是 `resume.export.templates`，界面不抄第二份清单）。 */
  const [templates, setTemplates] = useState<ResumeTemplateSummaryView[]>([]);
  const [templateId, setTemplateId] = useState('classic');
  const [lastImport, setLastImport] = useState<ImportReceiptView>();
  const [importError, setImportError] = useState<AppErrorPayload>();
  const [pending, setPending] = useState<PendingImportRowView[]>([]);
  /** 打开的编辑器文档 id（裁定⑩：编辑器是另起一只组件，由这一颗按钮进入，不占首页位）。 */
  const [editorDocId, setEditorDocId] = useState<string>();
  /** 编辑轨那块视图的开合（裁定⑩ 同一取向：另起组件、按钮进入，不占首页位；它编辑的是用户手里的文件，与种子文档无关）。 */
  const [pdfEditOpen, setPdfEditOpen] = useState(false);
  const bridge = window.autoCC;

  /**
   * 重读待确认清单（spec 4.1-04）：导入落库与确认都发生在主进程，界面不猜它当下的状态，
   * 所以每个动作结束后都调一次 `resume.parse.pending`（AGENTS.md §2.5）。
   */
  const read = useCallback(async () => {
    const reply = await bridge?.resume['parse.pending']();
    if (reply?.ok) setPending(reply.value);
  }, [bridge]);

  /**
   * 进门先问三句：能摆哪些模板、人上次设定用哪一套（spec 3.2-03 的用户可设定半边）、
   * 以及**库里已经有哪些简历**（`resume.doc.list`，只过 id / 姓名 / 时间）。
   *
   * 第三条是本轮整测补的：`docId` 过去只由「导入回执」和「种子回执」喂，于是**刷新一次页面**
   * 预览 / 导出 / 进编辑器三颗就集体回到 `NO_CURRENT_DOC`——库里明明躺着刚导入的那份。
   * 挂载时按「最近改动的那一份」把它接上，人也可以在上面那栏里换。只在挂载时问：清单是库读数，
   * 面板这一层的动作要么自己写进 `docId`（导入/种子），要么不改它。
   */
  useEffect(() => {
    void (async () => {
      const [list, pref, docs] = await Promise.all([
        bridge?.resume['export.templates'](),
        bridge?.resume['export.preference'](),
        bridge?.resume['doc.list'](),
      ]);
      if (list?.ok) setTemplates(list.value);
      if (pref?.ok) setTemplateId(pref.value.templateId);
      if (docs?.ok) {
        setDocs(docs.value);
        setDocId((current) => current ?? docs.value[0]?.id);
      }
    })();
  }, [bridge]);
  const { busy, notice, noticeTone, run } = useBridgeAction(read);

  /**
   * 导入一份简历文件（spec 4.1-06 / 07）：把绝对路径交给主进程 `resume.parse.fromFile`，
   * 抽取、脱敏、判定、入库全在主进程做，界面只摆回执与待确认标记（§2.5）。
   * 同一份文件重复导入时 `isNew` 为假，提示要说「已导入过、内容没变」而不是假装写了一遍新文档（4.1-07）。
   */
  const importResume = () =>
    void run(t('resume.import'), () => bridge?.resume['parse.fromFile'](importPath.trim()), {
      apply: (value) => {
        setLastImport(value);
        setImportError(undefined);
        setDocId(value.docId);
      },
      onError: setImportError,
      describe: (value) =>
        value.status === 'scanned'
          ? t('resume.importScanned', { textLength: value.textLength })
          : value.isNew
            ? t('resume.importDone', {
                docId: value.docId,
                format: t(FORMAT_LABEL_KEY[value.format]),
                textLength: value.textLength,
                count: value.issues.length,
              })
            : t('resume.importDup', { docId: value.docId }),
    });

  /**
   * 请系统弹「打开文件」面板，把人选中的那条路径写进导入框（spec 4.1-01 的入口半边）。
   *
   * 渲染层在 sandbox 下没有读文件的通道（§8.1），所以这一步只能由主进程代问；
   * 人取消时不报错也不改框里的内容——取消不是一次失败的动作。
   */
  const pickImportFile = () =>
    void run(
      t('resume.pickFile'),
      () =>
        bridge?.shell.selectFile({
          title: t('resume.pickerTitle'),
          filters: [
            { name: t('resume.pickerFilterResume'), extensions: ['pdf', 'docx', 'md', 'txt'] },
            { name: t('resume.pickerFilterAll'), extensions: ['*'] },
          ],
        }),
      {
        apply: (value) => {
          if (value.filePath !== null) setImportPath(value.filePath);
        },
        describe: (value) =>
          value.filePath === null ? t('resume.pickerCanceled') : t('resume.pickerPicked', { path: value.filePath }),
      },
    );

  /**
   * 把当前选中的模板写成人设定的默认模板（3.2-03：此后不给模板 id 的预览与导出都用它）。
   * 写入走 `resume.export.setPreference`，未知 id 由主进程拒绝，界面不自己判模板存在性（§2.5）。
   */
  const rememberTemplate = () =>
    void run(t('resume.setTemplate'), () => bridge?.resume['export.setPreference'](templateId), {
      describe: (value) => t('resume.templateSet', { template: value.templateId }),
    });

  /**
   * 落一份演示文档（`base` 或 `edited`），成功后立刻按当前语言渲一次预览（种子与预览一次点到位）。
   * @param variant 种子的版本——`edited` 用来在同一 docId 上落第二版内容，好让 3.7-03 的 diff 有得比
   */
  const loadDemo = (variant: 'base' | 'edited') =>
    void run(
      t(variant === 'base' ? 'resume.seed' : 'resume.seedEdited'),
      () => bridge?.resume['export.seedDemo'](variant),
      {
        apply: (value) => {
          setDocId(value.docId);
          setReceipt(undefined);
        },
        describe: (value) => t('resume.seedReceipt', { docId: value.docId }),
      },
    );

  /**
   * 拉取预览 HTML 并塞进 iframe——与导出走的是同一份打印 HTML 源（3.3-01）。
   * @param targetDocId 已落库的文档 id
   */
  const renderPreview = (targetDocId: string) =>
    void run(t('resume.preview'), () => bridge?.resume['export.preview'](targetDocId, templateId, locale), {
      apply: (html) => setPreviewHtml(html),
      describe: () => t('resume.previewDone'),
    });

  /**
   * 导出 PDF：主进程离屏视图 printToPDF → 落 userData/exports → 回写页数，界面摆回执（3.3-04 / 05 / 09）。
   * @param targetDocId 已落库的文档 id
   */
  const exportPdf = (targetDocId: string) =>
    void run(t('resume.export'), () => bridge?.resume['export.toPdf'](targetDocId, templateId, locale), {
      apply: (value) => {
        setReceipt(value);
        // 09 稿形态① 1-B：产物是磁盘上的一份 PDF，当前视野里翻不到它，所以除了按钮自带的那格回执，
        // 还要在左下角补一只 toast 把落点说清楚——稿子里"结果不在视野才配 toast"指的就是这一类。
        pushDeskToast({
          action: 'resume-export-toast',
          tone: 'jade',
          message: t('resume.exportToast', { path: value.path }),
          // 稿上 1-B 的第二段动作（spec 6.2-12）：PDF 是主进程自己写进 userData/exports 的产物，
          // 正好落在 reveal 口的边界内。备份那一只不挂这颗键——它的路径是用户敲的。
          revealPath: value.path,
        });
      },
      describe: (value) => t('resume.exportReceipt', { pages: value.pages, bytes: value.bytes }),
    });

  /**
   * 注入一次导出失败（对不存在的文档调 `toPdf`），让主进程的 `AppErrorPayload` 经同一个
   * `run` 外壳显示为可读中文提示——spec 3.3-11「注入失败 → 截图错误态，主进程不崩」的界面入口。
   */
  const injectFailure = () =>
    void run(t('resume.fail'), () => bridge?.resume['export.toPdf'](FAILURE_DOC_ID, templateId, locale), {
      onError: (error) =>
        // 失败那一只不许 8 秒就收（09 稿 1-A 写的"失败不自动回落，必须人读过"，与 spec 6.2-02 同一条）：
        // 只能由人再动一次或按 Esc 撤掉。
        pushDeskToast({
          action: 'resume-fail-toast',
          tone: 'seal',
          message: t('resume.failToast', { message: error.message }),
        }),
    });

  /**
   * 读回该文档的快照历史（spec 3.7-01 的列表），并把起点/终点预置成「最旧 ↔ 最新」——
   * 于是界面与 harness 都只需再点一次「比对」就能看到差异落在哪几行（3.7-03）。
   * @param targetDocId 已落库的文档 id
   */
  const loadSnapshots = (targetDocId: string) =>
    void run(t('resume.snapshots'), () => bridge?.resume['snapshot.list'](targetDocId), {
      apply: (items) => {
        setSnapshots(items);
        setDiff(undefined);
        const oldest = items[items.length - 1];
        const newest = items[0];
        setFromId(oldest ? oldest.snapshotId : '');
        setToId(items.length > 1 && newest ? newest.snapshotId : '');
      },
      describe: (items) => t('resume.snapshotCount', { count: items.length }),
    });

  /**
   * 比对选中的两份快照（spec 3.7-03）：差异由主进程算，界面只摆读数，不在渲染层重算一遍（§2.5）。
   */
  const compareSnapshots = () =>
    void run(t('resume.diff'), () => bridge?.resume['snapshot.diff'](fromId, toId), {
      apply: (value) => setDiff(value),
      describe: (value) =>
        t(value.isEmpty ? 'resume.diffEmpty' : 'resume.diffSections', { count: value.sections.length }),
    });

  /**
   * 把一条快照摘要拼成选择器里的一行文字。
   * 模板 id / 时刻 / hash 前缀全部作插值参数交给 i18n，界面不自己拼句子（§5.7）。
   * @param item `snapshot.list` 返回的一条快照摘要
   */
  const snapshotLabel = (item: SnapshotMetaView) =>
    t('resume.snapshotOption', {
      template: item.templateId,
      time: new Date(item.createdAt).toLocaleTimeString(),
      hash: item.hash.slice(0, 8),
    });

  /** 上一条动作还在途——这一档原因是本面板十只按钮共用的那一条。 */
  const busyReason = busy !== undefined ? 'ACTION_BUSY' : undefined;

  /**
   * 原因码对人说的话（07 稿④：只给码不给这句话，禁用就成了"界面不说谎"的反例）。
   * @param code 该按钮当下的原因码，可用时为 undefined
   */
  const reasonLabel = (code?: string): string | undefined =>
    code === undefined ? undefined : t(`resume.reason.${code}`);

  const importReason = importPath.trim() === '' ? 'IMPORT_PATH_EMPTY' : busyReason;
  const noDocReason = docId === undefined ? 'NO_CURRENT_DOC' : busyReason;
  const editorReason = editorDocId !== undefined ? 'EDITOR_OPEN' : noDocReason;
  const pdfEditReason = pdfEditOpen ? 'PDF_EDIT_OPEN' : busyReason;
  const templateReason = templates.length === 0 ? 'TEMPLATE_LIST_PENDING' : busyReason;
  const rememberReason = noDocReason !== undefined && busyReason !== undefined ? busyReason : templateReason;
  const diffReason = fromId === '' || toId === '' ? 'SNAPSHOT_MISSING' : fromId === toId ? 'SNAPSHOT_SAME' : busyReason;

  return (
    <section data-testid="resume-panel" className="rounded-xl border border-line bg-ink-900/60 p-4">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
          <FileText size={16} />
          {t('resume.heading')}
        </h2>
        <label className="flex items-center gap-1 text-[11px] text-slate-400">
          {t('resume.locale')}
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
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="flex flex-1 items-center gap-1 text-[11px] text-slate-400">
          {t('resume.importPath')}
          <DeskField
            action="resume-import-path"
            data-testid="resume-import-path"
            value={importPath}
            onValueChange={setImportPath}
            className="min-w-[240px] flex-1"
          />
        </label>
        {/* 导入落的是本机库里那份脱敏文档：琥珀那一档（本机写入）。 */}
        <DeskButton
          action="pick-file"
          variant="line"
          compact
          busy={!!busy}
          disabled={!!busy}
          disabledReason={busyReason}
          disabledReasonLabel={reasonLabel(busyReason)}
          onClick={pickImportFile}
        >
          <FolderOpen size={12} />
          {t('resume.pickFile')}
        </DeskButton>
        <DeskButton
          action="import"
          variant="amber"
          compact
          busy={!!busy}
          disabled={importReason !== undefined}
          disabledReason={importReason}
          disabledReasonLabel={reasonLabel(importReason)}
          onClick={importResume}
        >
          <Upload size={12} />
          {t('resume.import')}
        </DeskButton>
      </div>

      <p className="mt-1 text-[11px] text-slate-500" data-testid="resume-import-hint">
        {t('resume.importHint')}
      </p>

      {importError && (
        <Banner tone="seal" markers={{ testid: 'resume-import-error' }} className="mt-2 break-all">
          {t('resume.importError', { code: importError.code, message: importError.message })}
        </Banner>
      )}

      {lastImport && (
        <div className="mt-2 flex flex-wrap items-center gap-1" data-testid="resume-import-sections">
          {lastImport.sections.map((section) => (
            <span
              key={section.kind}
              data-testid="resume-import-section"
              className="rounded border border-line px-1 text-[11px] text-slate-400"
            >
              {t(`resume.kind.${section.kind}`)} · {section.entries}
            </span>
          ))}
        </div>
      )}

      {pending.length === 0 ? (
        <p className="mt-2 text-[11px] text-slate-500" data-testid="resume-pending-empty">
          {t('resume.pendingEmpty')}
        </p>
      ) : (
        <div className="mt-2 rounded-md border border-line bg-ink-950/60 p-3" data-testid="resume-pending-list">
          <h3 className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-300">
            <ListChecks size={14} />
            {t('resume.pending')} · {t('resume.pendingCount', { count: pending.length })}
          </h3>
          <ul className="mt-2 space-y-2">
            {pending.map((row) => (
              <li
                key={row.sourceHash}
                data-testid="resume-pending-row"
                data-status={row.status}
                className="rounded border border-line px-2 py-1.5"
              >
                <p className="text-[11px] text-slate-400">
                  {t('resume.pendingRow', {
                    docId: row.docId,
                    textLength: row.textLength,
                    time: new Date(row.updatedAt).toLocaleTimeString(),
                  })}{' '}
                  · {t(row.status === 'scanned' ? 'resume.statusScanned' : 'resume.statusImported')} ·{' '}
                  {t(FORMAT_LABEL_KEY[row.format])}
                </p>
                <ul className="mt-1 space-y-0.5 pl-2">
                  {row.issues.map((issue, index) => (
                    <li
                      key={`${issue.code}-${issue.fieldKey ?? 'doc'}-${String(index)}`}
                      data-testid="resume-pending-issue"
                      className="flex flex-wrap items-baseline gap-1 text-[11px] text-slate-500"
                    >
                      <span className="rounded border border-amber/45 px-1 text-amber">
                        {t(ISSUE_LABEL_KEY[issue.code])}
                      </span>
                      <span>{issue.sectionKind ?? '-'}</span>
                      <span className="break-all">{issue.excerpt}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 「当前简历」是一栏而不是一个隐含状态：预览 / 导出 / 编辑器 / 快照四组动作都吃同一个 `docId`，
          库里多份时没有这一栏，人就只能看到「先导入一份简历」那句已经过时的话。 */}
      <div className="mt-3 flex items-center gap-2">
        <DeskSelect
          action="resume-doc"
          data-testid="resume-doc"
          label={t('resume.docLabel')}
          value={docId ?? ''}
          onValueChange={setDocId}
          disabled={docs.length === 0}
          disabledReason={docs.length === 0 ? 'NO_DOC' : undefined}
          disabledReasonLabel={docs.length === 0 ? reasonLabel('NO_DOC') : undefined}
        >
          {docs.map((doc) => (
            <option key={doc.id} value={doc.id}>
              {doc.name ?? doc.id}
            </option>
          ))}
        </DeskSelect>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {/* 写本机的只有这三只（种子两版 + 导出落 userData），统一琥珀；预览是只读渲染、
            注入失败只是让主进程回一个错误载荷，都不许占外发那一档的朱砂。 */}
        <DeskButton
          action="seed"
          variant="amber"
          compact
          busy={!!busy}
          disabled={!!busy}
          disabledReason={busyReason}
          disabledReasonLabel={reasonLabel(busyReason)}
          onClick={() => loadDemo('base')}
        >
          <RefreshCw size={12} />
          {t('resume.seed')}
        </DeskButton>
        <DeskButton
          action="seed-edited"
          variant="amber"
          compact
          busy={!!busy}
          disabled={!!busy}
          disabledReason={busyReason}
          disabledReasonLabel={reasonLabel(busyReason)}
          onClick={() => loadDemo('edited')}
        >
          <FileText size={12} />
          {t('resume.seedEdited')}
        </DeskButton>
        <DeskButton
          action="preview"
          variant="line"
          compact
          busy={!!busy}
          disabled={noDocReason !== undefined}
          disabledReason={noDocReason}
          disabledReasonLabel={reasonLabel(noDocReason)}
          onClick={() => docId !== undefined && renderPreview(docId)}
        >
          <Eye size={12} />
          {t('resume.preview')}
        </DeskButton>
        <DeskButton
          action="export"
          variant="amber"
          compact
          busy={!!busy}
          disabled={noDocReason !== undefined}
          disabledReason={noDocReason}
          disabledReasonLabel={reasonLabel(noDocReason)}
          onClick={() => docId !== undefined && exportPdf(docId)}
        >
          <FileDown size={12} />
          {t('resume.export')}
        </DeskButton>
        <DeskButton
          action="fail"
          variant="ghost"
          compact
          busy={!!busy}
          disabled={!!busy}
          disabledReason={busyReason}
          disabledReasonLabel={reasonLabel(busyReason)}
          onClick={injectFailure}
        >
          <Ban size={12} />
          {t('resume.fail')}
        </DeskButton>
        <DeskButton
          action="open-editor"
          variant="solid"
          compact
          busy={!!busy}
          disabled={editorReason !== undefined}
          disabledReason={editorReason}
          disabledReasonLabel={reasonLabel(editorReason)}
          onClick={() => docId !== undefined && setEditorDocId(docId)}
        >
          <SlidersHorizontal size={12} />
          {t('resume.editor.enter')}
        </DeskButton>
        <DeskButton
          action="open-pdf-edit"
          variant="solid"
          compact
          busy={!!busy}
          disabled={pdfEditReason !== undefined}
          disabledReason={pdfEditReason}
          disabledReasonLabel={reasonLabel(pdfEditReason)}
          onClick={() => setPdfEditOpen(true)}
        >
          <Pencil size={12} />
          {t('pdfEdit.enter')}
        </DeskButton>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1 text-[11px] text-slate-400">
          {t('resume.templateLabel')}
          <DeskSelect
            action="resume-template"
            data-testid="resume-template"
            value={templateId}
            onValueChange={setTemplateId}
            className="max-w-[260px]"
          >
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </DeskSelect>
        </label>
        <DeskButton
          action="remember-template"
          variant="line"
          compact
          busy={!!busy}
          disabled={rememberReason !== undefined}
          disabledReason={rememberReason}
          disabledReasonLabel={reasonLabel(rememberReason)}
          onClick={rememberTemplate}
        >
          <BookmarkPlus size={12} />
          {t('resume.setTemplate')}
        </DeskButton>
        <span className="text-[11px] text-slate-500" data-testid="resume-template-count">
          {t('resume.templateCount', { count: templates.length })}
        </span>
      </div>

      {notice && (
        <Banner tone={noticeTone} markers={{ testid: 'resume-notice' }} className="mt-2 break-all">
          {notice}
        </Banner>
      )}

      {receipt && (
        <p className="mt-2 break-all text-[11px] text-slate-500" data-testid="resume-receipt-path">
          {receipt.path}
        </p>
      )}

      {/* 编辑器一旦打开就摆在面板预览之上：3.6 的判据要看的是"改完立刻在编辑器自己的预览里见效"，
          与本面板那份 `resume.export.preview`（已存的那份）分开摆，免得两张图分不清谁是谁。 */}
      {editorDocId && <ResumeEditor docId={editorDocId} onClose={() => setEditorDocId(undefined)} />}

      {/* 编辑轨那块视图（plan §7.5 的第三视图，裁定⑩ 同一形态：另起组件、由一颗按钮进入、不占首页位）。
          与排版编辑器同一层摆在生成轨预览之上：它编辑的是用户手里的文件，与本面板的种子文档/预览互不相干。 */}
      {pdfEditOpen && <PdfEditPanel onClose={() => setPdfEditOpen(false)} />}

      {previewHtml ? (
        <iframe
          data-testid="resume-preview"
          title={t('resume.heading')}
          sandbox=""
          srcDoc={previewHtml}
          className="mt-3 h-[520px] w-full rounded-md border border-line bg-white"
        />
      ) : (
        <p className="mt-3 text-[11px] text-slate-500" data-testid="resume-preview-empty">
          {t('resume.previewEmpty')}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <DeskButton
          action="snapshots"
          variant="line"
          compact
          busy={!!busy}
          disabled={noDocReason !== undefined}
          disabledReason={noDocReason}
          disabledReasonLabel={reasonLabel(noDocReason)}
          onClick={() => {
            setSnapshotsOpen(true);
            if (docId !== undefined) loadSnapshots(docId);
          }}
        >
          <History size={12} />
          {t('resume.snapshots')}
        </DeskButton>
        <DeskButton
          action="diff"
          variant="line"
          compact
          busy={!!busy}
          disabled={diffReason !== undefined}
          disabledReason={diffReason}
          disabledReasonLabel={reasonLabel(diffReason)}
          onClick={() => {
            setSnapshotsOpen(true);
            compareSnapshots();
          }}
        >
          <GitCompareArrows size={12} />
          {t('resume.diff')}
        </DeskButton>
      </div>

      <Drawer
        action="snapshots"
        open={snapshotsOpen}
        title={t('resume.snapshots')}
        subtitle={snapshots.length > 0 ? t('resume.snapshotCount', { count: snapshots.length }) : undefined}
        onClose={() => setSnapshotsOpen(false)}
      >
        {snapshots.length > 0 && (
          <div className="flex flex-wrap gap-3" data-testid="snapshot-list">
            <label className="flex items-center gap-1 text-[11px] text-slate-400">
              {t('resume.diffFrom')}
              <DeskSelect
                action="snapshot-diff-from"
                data-testid="snapshot-diff-from"
                value={fromId}
                onValueChange={(value) => {
                  setFromId(value);
                  setDiff(undefined);
                }}
                className="max-w-[260px]"
              >
                {snapshots.map((item) => (
                  <option key={`from-${item.snapshotId}`} value={item.snapshotId}>
                    {snapshotLabel(item)}
                  </option>
                ))}
              </DeskSelect>
            </label>
            <label className="flex items-center gap-1 text-[11px] text-slate-400">
              {t('resume.diffTo')}
              <DeskSelect
                action="snapshot-diff-to"
                data-testid="snapshot-diff-to"
                value={toId}
                onValueChange={(value) => {
                  setToId(value);
                  setDiff(undefined);
                }}
                className="max-w-[260px]"
              >
                {snapshots.map((item) => (
                  <option key={`to-${item.snapshotId}`} value={item.snapshotId}>
                    {snapshotLabel(item)}
                  </option>
                ))}
              </DeskSelect>
            </label>
            {/* 换完版本对就在栏内重比（09 稿形态④ 4-A 的对照动作与选择器同在一栏）。
                不在 onValueChange 里即时重比：连改两只选择器时，前一条还在途的差异会贴到新版本对上，
                界面就成了说谎；按一次比一次，且"上一条还在途"由原因码说给人听（07 稿④）。 */}
            <DeskButton
              action="snapshot-compare"
              variant="line"
              compact
              busy={!!busy}
              disabled={diffReason !== undefined}
              disabledReason={diffReason}
              disabledReasonLabel={reasonLabel(diffReason)}
              onClick={compareSnapshots}
            >
              <GitCompareArrows size={12} />
              {t('resume.diff')}
            </DeskButton>
          </div>
        )}

        {diff && (
          <div className="mt-3 border-t border-line" data-testid="snapshot-diff">
            {diff.isEmpty ? (
              <p className="py-2.5 text-[11px] text-slate-400" data-testid="snapshot-diff-empty">
                {t('resume.diffEmpty')}
              </p>
            ) : (
              <ul>
                {diff.sections.map((section) => (
                  <li
                    key={section.sectionId}
                    data-testid="diff-section"
                    className="border-b border-line py-2.5 last:border-b-0"
                  >
                    <p
                      className="flex flex-wrap items-center gap-1.5 text-[11px] font-semibold text-slate-300"
                      data-testid="diff-section-heading"
                    >
                      <Tag tone={CHANGE_TONE[section.change]}>{t(CHANGE_LABEL_KEY[section.change])}</Tag>
                      {t(`resume.kind.${section.kind}`)}
                    </p>
                    <ul className="mt-1 space-y-1 pl-3">
                      {section.entries.map((entry) => (
                        <li key={entry.entryId} data-testid="diff-entry">
                          <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
                            <Tag tone={CHANGE_TONE[entry.change]}>{t(CHANGE_LABEL_KEY[entry.change])}</Tag>
                            {entry.entryId}
                          </p>
                          <ul className="mt-0.5 space-y-0.5 pl-3">
                            {entry.fields.map((field) => (
                              <li
                                key={field.key}
                                data-testid="diff-field"
                                className="flex flex-wrap items-baseline gap-1 text-[11px]"
                              >
                                <span className="text-slate-500">{field.key}</span>
                                <span className="break-all text-slate-400 line-through">
                                  {field.before ?? t('resume.valueAbsent')}
                                </span>
                                <span className="text-slate-600">→</span>
                                <span className="break-all text-jade-ink">
                                  {field.after ?? t('resume.valueAbsent')}
                                </span>
                                {field.locked && (
                                  <Tag tone="amber" data-testid="diff-field-locked">
                                    {t('resume.fieldLocked')}
                                  </Tag>
                                )}
                              </li>
                            ))}
                          </ul>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Drawer>
    </section>
  );
}
