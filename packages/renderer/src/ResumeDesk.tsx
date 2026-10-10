import {
  Ban,
  Eye,
  FileDown,
  FileText,
  FlaskConical,
  FolderOpen,
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
import { GapPanel } from './GapPanel';
import { GeneratePanel } from './GeneratePanel';
import { KbPanel } from './KbPanel';
import { PdfEditPanel } from './PdfEditPanel';
import { ResumeEditor } from './ResumeEditor';
import { ResumePaperStage, type ResumePaperMode } from './ResumePaperStage';
import { TemplateShelf, type ResumeShelfFilter } from './TemplateShelf';
import { Banner, DeskButton, DeskField, DeskSelect, Tag } from './ui/controls';
import { DeskExplainer, DeskSection } from './ui/disclosure';
import { Drawer, useRevealLabel } from './ui/overlays';
import { useBridgeAction } from './useBridgeAction';
import { useViewTrail } from './viewTrail';

/** 故意不存在的文档 id：供「注入失败导出」那颗键触发主进程返回 `AppErrorPayload`（spec 3.3-11 的验证入口）。 */
const FAILURE_DOC_ID = 'resume-fail-injected';

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

/** 变更类型 → 文案键（`added`/`removed`/`modified` 三种在界面上的说法不同，颜色也不同）。 */
const CHANGE_LABEL_KEY = {
  added: 'resume.changeAdded',
  removed: 'resume.changeRemoved',
  modified: 'resume.changeModified',
} as const;

/**
 * 变更类型 → 芯片语气档（09 稿形态④ 4-A）：新增青玉、删除朱砂、改述走中性。
 * 这三档说的是"这一条是加/删/改"，不是"办好了/有风险"——判定语义仍由主进程的 diff 给出，界面不改判（§2.5）。
 */
const CHANGE_TONE: Record<keyof typeof CHANGE_LABEL_KEY, 'jade' | 'seal' | undefined> = {
  added: 'jade',
  removed: 'seal',
  modified: undefined,
};

/**
 * 简历屏的「一页纸工作台」（spec 6.4-07…11 / plan §3.26，第五十六片起）。
 *
 * **形状依据是 2026-10-09 的四条裁定**（用户在 AskUserQuestion 里选的，不是我推的）：
 * ① 左右分栏——左列操作、右列一张纸常驻；② 模板走版式骨架缩略图网格；
 * ③ 预览 / 排版 / PDF 覆盖三种画面共用同一纸面槽位、由键位进入；④ 三颗开发夹具退出产品列、进「自测台」抽屉。
 *
 * 改造前的样子（病灶逐条在 plan §3.26 的表里）：`PANELS.resume` 平铺四块全宽面板、65 只键一列排到底，
 * `seed` / `seed-edited` / `fail` 与「导入 / 预览 / 导出」挤在同一行，预览 iframe 之前压着 330 行控件，
 * 而 50 套模板是一只看不见差别的 `<select>`。
 *
 * 状态归属：这一层是 `docId` / 模板 / 纸面档 / 导出回执的**唯一持有者**（风险① 的对策），
 * 挂进来的 `GeneratePanel` 改吃 props；读数一律来自 `window.autoCC` 的既有白名单调用，界面不自己算（§2.5）。
 */
export function ResumeDesk() {
  const { t } = useTranslation();
  // 纸右下角那颗「在访达中显示」与 toast 上的同名动作共用一句文案（`ui/overlays` 那一处推导）。
  const revealLabel = useRevealLabel();
  const bridge = window.autoCC;
  const [locale, setLocale] = useState<ResumeLocaleView>('zh-CN');
  const [previewHtml, setPreviewHtml] = useState<string>();
  const [receipt, setReceipt] = useState<ExportReceiptView>();
  const [snapshots, setSnapshots] = useState<SnapshotMetaView[]>([]);
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [diff, setDiff] = useState<SnapshotDiffView>();
  /** 快照历史 / 版本对照抽屉的开合（09 稿形态④ 4-A：对照要"两边同时看"，所以是抽屉不是面板底下一截长条）。 */
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
  /** 「自测台」抽屉（裁定④）：三颗夹具键住在这里，键名一字未改。 */
  const [fixturesOpen, setFixturesOpen] = useState(false);
  const [importPath, setImportPath] = useState('');
  /**
   * 这一屏正在操作的那份文档 id——**desk 是唯一持有者**。
   * 来源三条：导入回执、待确认清单里的已导入行、示例种子，外加挂载时按「最近改动的那一份」接上（3.3 整测补的那条）。
   */
  const [docId, setDocId] = useState<string>();
  /** 库里的候选（只到摘要一层：id / 姓名 / 最后改动时刻），供「选简历」那一格与 `GeneratePanel` 共用。 */
  const [docs, setDocs] = useState<ResumeDocSummaryView[]>([]);
  /** 可摆的模板清单（含版式骨架的七条轴）、当前用来出纸的那一套、人设定的那一套（3.2-03）。 */
  const [templates, setTemplates] = useState<ResumeTemplateSummaryView[]>([]);
  const [templateId, setTemplateId] = useState('classic');
  const [defaultTemplateId, setDefaultTemplateId] = useState('classic');
  /** 模板架的筛选（父级持有：收起再展开、切走再切回都不该把人筛掉的东西偷偷放回来）。 */
  const [shelfFilter, setShelfFilter] = useState<ResumeShelfFilter>({});
  const [lastImport, setLastImport] = useState<ImportReceiptView>();
  const [importError, setImportError] = useState<AppErrorPayload>();
  const [pending, setPending] = useState<PendingImportRowView[]>([]);
  /** 纸面槽此刻是哪一档（预览 / 排版 / PDF 覆盖，裁定③）。 */
  const [paperMode, setPaperMode] = useState<ResumePaperMode>('preview');
  /** 09 稿形态⑥ 的那一跳：落点是简历屏时，「定制生成」那一格必须被强制打开（见 `DeskSection.openSignal`）。 */
  const trail = useViewTrail();

  /**
   * 重读库里的简历清单，并把「当前那一份」接上。
   *
   * 这一口是三处共用的（挂进来的 `GeneratePanel` 也吃它，§2.2 不留第二份实现）：清单里还有当前这一份
   * 就原样留着，已经被删掉或第一次进门才取「最近改动的那一份」。3.3 整测那轮补的正是这一条——
   * 刷新一次页面后库里明明躺着刚导入的简历，`docId` 却是空的，三颗键集体回到 `NO_CURRENT_DOC`。
   */
  const refreshDocs = useCallback(async () => {
    const reply = await bridge?.resume['doc.list']();
    if (!reply?.ok) return;
    const list = reply.value;
    setDocs(list);
    setDocId((current) => (current !== undefined && list.some((doc) => doc.id === current) ? current : list[0]?.id));
  }, [bridge]);

  /**
   * 重读待确认清单（spec 4.1-04）与库里的简历清单：导入落库与确认都发生在主进程，界面不猜它当下的状态，
   * 所以每个动作结束后都调一次 `resume.parse.pending` + `resume.doc.list`（§2.5）。
   */
  const read = useCallback(async () => {
    const reply = await bridge?.resume['parse.pending']();
    if (reply?.ok) setPending(reply.value);
    await refreshDocs();
  }, [bridge, refreshDocs]);

  /**
   * 进门先问三句：能摆哪些模板（含骨架轴）、人上次设定用哪一套、以及库里已经有哪些简历。
   * 只在挂载时问：这三样都是库读数，屏内的动作要么自己写进 state，要么由 `read` 重读。
   */
  useEffect(() => {
    void (async () => {
      const [list, pref] = await Promise.all([
        bridge?.resume['export.templates'](),
        bridge?.resume['export.preference'](),
      ]);
      if (list?.ok) setTemplates(list.value);
      if (pref?.ok) {
        setTemplateId(pref.value.templateId);
        setDefaultTemplateId(pref.value.templateId);
      }
      await refreshDocs();
    })();
  }, [bridge, refreshDocs]);
  const { busy, notice, noticeTone, run, setNotice } = useBridgeAction(read);

  /**
   * 换纸面档。**判门只在这一处**：排版那一档吃当前文档，没有文档就不换档、把原因说给人听，
   * 而不是把人送进一张空编辑器（页签点下去必须有回应，静默拒绝是说谎）。
   * @param next 目标档位
   */
  const requestPaperMode = (next: ResumePaperMode) => {
    if (next === 'layout' && docId === undefined) {
      setNotice(t('resume.reason.NO_CURRENT_DOC'), 'amber');
      return;
    }
    setPaperMode(next);
  };

  /**
   * 导入一份简历文件（spec 4.1-06 / 07）：绝对路径交给主进程 `resume.parse.fromFile`，
   * 抽取、脱敏、判定、入库全在主进程做，界面只摆回执与待确认标记（§2.5）。
   * @param filePath 人选中的那条路径；省略时吃导入框里的值（高级口那颗键）
   */
  const importResume = (filePath?: string) => {
    const target = (filePath ?? importPath).trim();
    return void run(t('resume.import'), () => bridge?.resume['parse.fromFile'](target), {
      apply: (value) => {
        setLastImport(value);
        setImportError(undefined);
        setDocId(value.docId);
        setPreviewHtml(undefined);
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
  };

  /**
   * 请系统弹「打开文件」面板并**直接导入**选中的那份（裁定：主入口是这颗键，不是那行路径框）。
   *
   * 渲染层在 sandbox 下没有读文件的通道（§8.1），所以这一步只能由主进程代问；
   * 人取消时不报错也不导入——取消不是一次失败的动作。
   */
  const pickAndImport = () =>
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
          if (value.filePath === null) return;
          setImportPath(value.filePath);
          void importResume(value.filePath);
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
      apply: () => setDefaultTemplateId(templateId),
      describe: (value) => t('resume.templateSet', { template: value.templateId }),
    });

  /**
   * 落一份演示文档（`base` / `edited`，spec 3.3-10 / 3.7-03 的取证入口），成功后立刻渲一次预览。
   * @param variant 种子的版本——`edited` 在同一 docId 上落第二版内容，好让 diff 有得比
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
   * 拉取预览 HTML 进纸面——与导出走的是同一份打印 HTML 源（3.3-01「预览即导出所见」）。
   *
   * 这是全屏唯一一处"内容变了要重新出纸"的落点：换文档、换模板、换语言、采纳改写都走它，
   * 于是纸面永远跟着事实翻面，而不是停在人上一次按的那一版。
   * @param targetDocId 已落库的文档 id
   * @param atTemplateId 出纸用的模板 id；省略时吃当前选中的那一套。
   *   **换版式那一跳必须显式传**：`setTemplateId` 在这一帧还没生效，不传就拿到上一次的那一套，
   *   表现为"点了新模板、纸上还是旧版式"。
   */
  const renderPreview = (targetDocId: string, atTemplateId: string = templateId) =>
    void run(t('resume.preview'), () => bridge?.resume['export.preview'](targetDocId, atTemplateId, locale), {
      apply: (html) => {
        setPreviewHtml(html);
        setPaperMode('preview');
      },
      describe: () => t('resume.previewDone'),
    });

  /**
   * 换一套版式：选中它并把这张纸立刻重渲一次（裁定② 的反馈闭环——选了就该看见）。
   * @param id 目标模板 id（来自 `resume.export.templates`，界面不自造）
   */
  const selectTemplate = (id: string) => {
    setTemplateId(id);
    if (docId !== undefined) renderPreview(docId, id);
  };

  /**
   * 导出 PDF：主进程离屏视图 printToPDF → 落 userData/exports → 回写页数，回执摆到纸右下角（3.3-04 / 05 / 09）。
   * @param targetDocId 已落库的文档 id
   */
  const exportPdf = (targetDocId: string) =>
    void run(t('resume.export'), () => bridge?.resume['export.toPdf'](targetDocId, templateId, locale), {
      apply: (value) => {
        setReceipt(value);
        // 09 稿形态① 1-B：产物是磁盘上的一份 PDF，当前视野里翻不到它，所以除了回执条，
        // 还在左下角补一只 toast 把落点说清楚——稿子里"结果不在视野才配 toast"指的就是这一类。
        pushDeskToast({
          action: 'resume-export-toast',
          tone: 'jade',
          message: t('resume.exportToast', { path: value.path }),
          // 稿上 1-B 的第二段动作（spec 6.2-12）：PDF 是主进程写进 userData/exports 的产物，落在 reveal 口的边界内。
          revealPath: value.path,
        });
      },
      describe: (value) => t('resume.exportReceipt', { pages: value.pages, bytes: value.bytes }),
    });

  /**
   * 把上一次导出的产物在系统文件管理器里选中（`shell.revealInFolder`，spec 6.2-12 的第二段动作）。
   * 路径是主进程自己写出来的那份，正好落在 reveal 口的边界内。
   */
  const revealReceipt = () =>
    void run(revealLabel, () => bridge?.shell.revealInFolder(receipt?.path ?? ''), {
      describe: () => undefined,
    });

  /**
   * 注入一次导出失败（对不存在的文档调 `toPdf`），让主进程的 `AppErrorPayload` 经同一个 `run` 外壳
   * 显示成可读中文——spec 3.3-11「注入失败 → 截图错误态，主进程不崩」的界面入口（自测台里的第三颗）。
   */
  const injectFailure = () =>
    void run(t('resume.fail'), () => bridge?.resume['export.toPdf'](FAILURE_DOC_ID, templateId, locale), {
      onError: (error) =>
        // 失败那一只不许 8 秒就收（09 稿 1-A"失败不自动回落，必须人读过"，与 spec 6.2-02 同一条）。
        pushDeskToast({
          action: 'resume-fail-toast',
          tone: 'seal',
          message: t('resume.failToast', { message: error.message }),
        }),
    });

  /**
   * 读回该文档的快照历史（spec 3.7-01），并把起点/终点预置成「最旧 ↔ 最新」——
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
   * 把一条快照摘要拼成选择器里的一行文字（模板 id / 时刻 / hash 前缀全作插值参数交给 i18n，§5.7）。
   * @param item `snapshot.list` 返回的一条快照摘要
   */
  const snapshotLabel = (item: SnapshotMetaView) =>
    t('resume.snapshotOption', {
      template: item.templateId,
      time: new Date(item.createdAt).toLocaleTimeString(),
      hash: item.hash.slice(0, 8),
    });

  /** 上一条动作还在途——这一档原因是本屏所有键共用的那一条。 */
  const busyReason = busy !== undefined ? 'ACTION_BUSY' : undefined;
  /**
   * 原因码对人说的话（07 稿④：只给码不给这句话，禁用就成了"界面不说谎"的反例）。
   * @param code 该按钮当下的原因码，可用时为 undefined
   */
  const reasonLabel = (code?: string): string | undefined =>
    code === undefined ? undefined : t(`resume.reason.${code}`);

  const importReason = importPath.trim() === '' ? 'IMPORT_PATH_EMPTY' : busyReason;
  const noDocReason = docId === undefined ? 'NO_CURRENT_DOC' : busyReason;
  const editorReason = noDocReason;
  const templateReason = templates.length === 0 ? 'TEMPLATE_LIST_PENDING' : busyReason;
  const diffReason = fromId === '' || toId === '' ? 'SNAPSHOT_MISSING' : fromId === toId ? 'SNAPSHOT_SAME' : busyReason;

  /** 当前那份的身份读数（姓名读不到就露 id——宁可露 id 也不给一个空白纸）。 */
  const currentDoc = docs.find((doc) => doc.id === docId);
  const docLabel = currentDoc ? (currentDoc.name ?? currentDoc.id) : undefined;
  const templateName = templates.find((template) => template.id === templateId)?.name;
  /** 采纳改写之后由 `GeneratePanel` 回调：纸面立刻重渲一次，人才看得见"改在那张纸上落定了"。 */
  const rerenderPaper = () => {
    if (docId !== undefined) renderPreview(docId);
  };

  return (
    // 查询容器必须挂在**祖先**上：元素自己的 `container-type` 不作为自己的查询容器（CSS Containment 把
    // 查询对象限定为最近的祖先容器）。这一条是活体量出来的：容器挂在自己身上时首读 `flexDirection`
    // 仍是 `column`，而左栏（真·后代）已经按 400px 摆好了。
    // 用 `@container` 而不是视口断点：右栏内核视图展开时主区只剩 486px，按视口量会误判成"够宽"
    // （与 `JobLabPanel` 同一口径，spec 6.4-04）。
    //
    // 换档点 **77rem = 1232px**，比抽屉/导航/键那条既有的 56rem 窄档（spec 6.4-06）**高一格**，
    // 而且不是随手加的半档——它是纸面自己提出的硬算术：左栏 400 + 栏间距 12 + 纸面内边距 24 +
    // A4 的 794px（`w-[210mm]` @96dpi）= **1230**。低于这一格还要分栏，528px 的槽位装不下 794px 的纸，
    // 只能整页横向滚，等于把人刚要看的那张纸切掉三分之二（本屏首读就是这个半页）；
    // 所以窄档退回单栏，把纸放在最上面按整宽摆——940px 的容器里 A4 完整可见，一行都不折。
    // 两处共用一个物理条件（"纸面装得下"），不是两套断点各说各话。
    <div className="@container min-w-0">
      <section data-testid="resume-panel" className="flex min-w-0 flex-col gap-3 @[77rem]:flex-row">
        <div className="order-2 flex min-w-0 flex-col gap-3 @[77rem]:order-1 @[77rem]:w-[400px] @[77rem]:shrink-0">
          {notice && (
            <Banner tone={noticeTone} markers={{ testid: 'resume-notice' }} className="break-all">
              {notice}
            </Banner>
          )}

          {/* ① 选简历：库里那份 + 从本机导入那一步。段头收起时也留着"当下是哪一份"，否则状态跟着一起消失。 */}
          <DeskSection
            id="resume.doc"
            title={t('desk.resume.sectionDoc')}
            summary={docLabel ?? t('desk.resume.sectionDocEmpty')}
            defaultOpen
            markers={{ testid: 'resume-section-doc' }}
          >
            <div className="flex flex-col gap-2">
              <DeskSelect
                action="resume-doc"
                data-testid="resume-doc"
                label={t('resume.docLabel')}
                value={docId ?? ''}
                onValueChange={(value) => setDocId(value === '' ? undefined : value)}
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

              {/* 主入口就是这颗键：选一份本机文件直接导入（裁定：绝对路径框降到"高级"里，不再是进门第一格）。
                琥珀那一档说的是"往本机库里写一份"——不是外发，所以不给朱砂。 */}
              <DeskButton
                action="pick-file"
                variant="amber"
                busy={!!busy}
                disabled={!!busy}
                disabledReason={busyReason}
                disabledReasonLabel={reasonLabel(busyReason)}
                onClick={pickAndImport}
              >
                <FolderOpen size={13} />
                {t('resume.pickFile')}
              </DeskButton>

              <DeskExplainer id="resume.import-advanced" label={t('desk.resume.advanced')}>
                <div className="flex flex-col gap-2">
                  <p className="text-slate-400">{t('resume.importHint')}</p>
                  <DeskField
                    action="resume-import-path"
                    data-testid="resume-import-path"
                    label={t('resume.importPath')}
                    value={importPath}
                    onValueChange={setImportPath}
                  />
                  <DeskButton
                    action="import"
                    variant="amber"
                    compact
                    busy={!!busy}
                    disabled={importReason !== undefined}
                    disabledReason={importReason}
                    disabledReasonLabel={reasonLabel(importReason)}
                    onClick={() => importResume()}
                  >
                    <Upload size={12} />
                    {t('resume.import')}
                  </DeskButton>
                </div>
              </DeskExplainer>

              {importError && (
                <Banner tone="seal" markers={{ testid: 'resume-import-error' }} className="break-all">
                  {t('resume.importError', { code: importError.code, message: importError.message })}
                </Banner>
              )}

              {lastImport && (
                <div className="flex flex-wrap items-center gap-1" data-testid="resume-import-sections">
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
            </div>
          </DeskSection>

          {/* ② 事实核对：待确认清单 + 知识库 + 缺口。默认收起——这一格最厚（两块既有面板），
            而它属于"回头要核对"而不是"进门就要做"，收起来才让出主视觉。 */}
          <DeskSection
            id="resume.facts"
            title={t('desk.resume.sectionFacts')}
            summary={
              pending.length === 0
                ? t('desk.resume.sectionFactsClean')
                : t('desk.resume.sectionFactsPending', { count: pending.length })
            }
            markers={{ testid: 'resume-section-facts' }}
          >
            <div className="flex min-w-0 flex-col gap-3">
              {pending.length === 0 ? (
                <p className="text-[11px] text-slate-500" data-testid="resume-pending-empty">
                  {t('resume.pendingEmpty')}
                </p>
              ) : (
                <div className="rounded-md border border-line bg-ink-950/60 p-3" data-testid="resume-pending-list">
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
                              <Tag tone="amber">{t(ISSUE_LABEL_KEY[issue.code])}</Tag>
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

              {/* 两块既有面板原样挂进来：只归位、不改逻辑（spec 6.3-03 的那条纪律在这一屏同样成立）。 */}
              <KbPanel />
              <GapPanel />
            </div>
          </DeskSection>

          {/* ③ 定制生成：按这一屏当前那份文档定制（`docId` 由 desk 持有，面板改吃 props，见风险①）。 */}
          <DeskSection
            id="resume.generate"
            title={t('desk.resume.sectionGenerate')}
            summary={
              docLabel ? t('desk.resume.sectionGenerateFor', { doc: docLabel }) : t('desk.resume.sectionDocEmpty')
            }
            defaultOpen
            // 岗位行双击跳过来时（09 稿形态⑥ / spec 6.4-05）强制打开这一格：收起态下正文是卸载的，
            // 人不该被送到一格看不见 JD 输入框的地方。
            openSignal={trail && trail.targetView === 'resume' ? trail.requestId : undefined}
            markers={{ testid: 'resume-section-generate' }}
          >
            <GeneratePanel
              docs={docs}
              docId={docId ?? ''}
              onDocIdChange={setDocId}
              refreshDocs={refreshDocs}
              onAccepted={rerenderPaper}
            />
          </DeskSection>

          {/* ④ 出纸：模板架（裁定② 的骨架缩略图）+ 这张纸的三把出口键 + 快照对照。 */}
          <DeskSection
            id="resume.output"
            title={t('desk.resume.sectionOutput')}
            summary={
              templateName
                ? t('desk.resume.sectionOutputWith', { template: templateName, locale })
                : t('desk.resume.sectionOutputNone')
            }
            defaultOpen
            markers={{ testid: 'resume-section-output' }}
          >
            <div className="flex min-w-0 flex-col gap-3">
              <TemplateShelf
                templates={templates}
                selectedId={templateId}
                defaultId={defaultTemplateId}
                filter={shelfFilter}
                onFilterChange={setShelfFilter}
                onSelect={selectTemplate}
                onSetDefault={rememberTemplate}
                busy={!!busy}
                disabledReason={templateReason}
                disabledReasonLabel={reasonLabel(templateReason)}
              />

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

              <div className="flex flex-wrap items-center gap-2">
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
                {/* 写本机userData 的这一颗走琥珀；预览是只读渲染，不给外发那一档的朱砂。 */}
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
                  action="open-editor"
                  variant="line"
                  compact
                  busy={!!busy}
                  disabled={editorReason !== undefined}
                  disabledReason={editorReason}
                  disabledReasonLabel={reasonLabel(editorReason)}
                  onClick={() => requestPaperMode('layout')}
                >
                  <SlidersHorizontal size={12} />
                  {t('resume.editor.enter')}
                </DeskButton>
                <DeskButton
                  action="open-pdf-edit"
                  variant="line"
                  compact
                  busy={!!busy}
                  disabled={!!busy}
                  disabledReason={busyReason}
                  disabledReasonLabel={reasonLabel(busyReason)}
                  onClick={() => requestPaperMode('pdf')}
                >
                  <Pencil size={12} />
                  {t('pdfEdit.enter')}
                </DeskButton>
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
            </div>
          </DeskSection>

          {/* 裁定④：三颗开发夹具退出产品列。键名（`seed` / `seed-edited` / `fail`）一字未改，
            spec 3.3-10 / 3.3-11 的取证通道因此不断；变的只是它们住在哪一格。 */}
          <DeskButton
            action="desk-fixtures"
            variant="ghost"
            compact
            onClick={() => setFixturesOpen(true)}
            className="self-start"
          >
            <FlaskConical size={12} />
            {t('desk.resume.fixtures')}
          </DeskButton>
        </div>

        {/* 右列：一张常驻的纸。宽档吸顶（左列滚到哪儿它都在），窄档整栏换到最上面——
          纵向退让时把纸摆在动作之前，主视觉不再被 330 行控件埋住（病灶③）。 */}
        <div className="order-1 min-w-0 flex-1 @[77rem]:sticky @[77rem]:top-0 @[77rem]:order-2">
          <ResumePaperStage
            mode={paperMode}
            onModeChange={requestPaperMode}
            previewHtml={previewHtml}
            layoutView={
              docId !== undefined ? (
                <ResumeEditor
                  docId={docId}
                  onClose={() => {
                    setPaperMode('preview');
                    rerenderPaper();
                  }}
                />
              ) : null
            }
            pdfView={<PdfEditPanel onClose={() => setPaperMode('preview')} />}
            docLabel={docLabel}
            templateName={templateName}
            locale={locale}
            receipt={receipt}
            onReveal={revealReceipt}
            busy={!!busy}
          />
        </div>

        <Drawer
          action="desk-fixtures"
          open={fixturesOpen}
          title={t('desk.resume.fixtures')}
          subtitle={t('desk.resume.fixturesHint')}
          onClose={() => setFixturesOpen(false)}
        >
          <div className="flex flex-col gap-2">
            <p className="text-[11px] leading-relaxed text-slate-400">{t('desk.resume.fixturesBody')}</p>
            <div className="flex flex-wrap items-center gap-2">
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
            </div>
          </div>
        </Drawer>

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
              {/* 换完版本对就在栏内重比（09 稿形态④ 4-A）。不在 onValueChange 里即时重比：
                连改两只选择器时，前一条还在途的差异会贴到新版本对上，界面就成了说谎。 */}
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
    </div>
  );
}
