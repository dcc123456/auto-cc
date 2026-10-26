import {
  Ban,
  BookOpen,
  Eye,
  FileText,
  FlaskConical,
  FolderOpen,
  GitCompareArrows,
  History,
  ListChecks,
  Maximize2,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';
import { type ComponentType, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AppErrorPayload,
  ImportProvenanceRowView,
  ImportReceiptView,
  PendingImportRowView,
  ResumeDocSummaryView,
  ResumeLocaleView,
  ResumeTemplateSummaryView,
  SnapshotDiffView,
  SnapshotMetaView,
} from '@auto-cc/shared';
import { DEMO_RESUME_DOC_ID } from '@auto-cc/shared';
import { pushDeskToast } from './deskToast';
import { formatClock } from './format';
import { GapPanel } from './GapPanel';
import { ChunkReviewSection } from './ChunkReviewSection';
import { GeneratePanel } from './GeneratePanel';
import { KbPanel } from './KbPanel';
import { PdfPaperView } from './PdfPaperView';
import { PdfViewPanel } from './PdfViewPanel';
import { PdfEditorPage } from './pdf-editor/PdfEditorPage';
import { ResumeEditPage } from './ResumeEditPage';
import { ResumePaperStage, type PaperStatus, type ResumePaperMode } from './ResumePaperStage';
import { SkillPanel } from './SkillPanel';
import { BLOCK_SELECTED_CLASS, Banner, DeskButton, DeskField, DeskSelect, DeskTab, Tag } from './ui/controls';
import { DeskActionRow, DeskExplainer, DeskSection } from './ui/disclosure';
import { Drawer, Modal } from './ui/overlays';
import { SplitHandle, useSplitWidth } from './ui/split';
import { useBridgeAction } from './useBridgeAction';
import { usePdfView } from './usePdfView';
import { useViewTrail } from './viewTrail';

/** 故意不存在的文档 id：供「注入失败导出」那颗键触发主进程返回 `AppErrorPayload`（spec 3.3-11 的验证入口）。 */
const FAILURE_DOC_ID = 'resume-fail-injected';

/**
 * 纸栏（右栏）可拖到的宽度区间与默认档（百分比），落盘键与内核视图那一支同形状、同一份 localStorage。
 *
 * 为什么是 40…62 而不是"随便拖"：这一档的两个端点都是算出来的，不是手感。
 * - 62 的上界：940px 容器（用户日常那扇 1200 窗）里 62% 给纸栏 583px，对面左列拿到 940−583−6−12 = **339px**，
 *   仍够摆"段头 + 一颗键 + 一行说明"（plan §3.27 裁定 2 因此不再为拖拽引第二道动态夹取）；
 * - 40 的下界：736px 分栏档（`@[46rem]`）里 40% 给纸栏 294px，缩放倍率 k≈0.36，是"还读得出双列还是单列"的地板；
 * - 默认 56：940 容器里正好复现 6.4-07 那批读数中的 400px 左列（526 + 6 + 12 + 396 ≈ 940）。
 * 像素而不是"整屏宽度百分比"在这里没有意义：分母是这一行，行宽随窗口变，人拖的是"这张纸占多宽"。
 */
const PAPER_WIDTH_MIN = 40;
const PAPER_WIDTH_MAX = 62;

/** 键盘微调的步长（百分点），与 `KernelViewSlot` 那一支同一条手势。 */
const PAPER_WIDTH_STEP = 2;

/** 没拖过时的默认档（也是把手双击的落点）。 */
const PAPER_WIDTH_DEFAULT = 56;

/** 纸栏宽度落盘键：几何偏好进 localStorage、不进 SQLite（沿用 8.8-01 的裁定"为一只宽度档开表不值当"）。 */
const PAPER_WIDTH_STORAGE_KEY = 'auto-cc.resume-desk.paper-width';

/** 纸栏宽度写在哪一枚 CSS 变量上（class 里的字面量 `w-(--resume-paper-width)` 引用它）。 */
const PAPER_WIDTH_VAR = '--resume-paper-width';

/**
 * 实时渲纸的尾随去抖窗口（ms）。取 `maxPreviewResponseMs: 1200`（spec 3.6-08 那档预算）的约 1/3：
 * 比它短，人一次连续操作里改的几条会被合成一趟；比它长一半，"左边一动右边就翻面"就退化成手动预览。
 * 收口时以活体读数校准，改这一格只改这里（全仓只有纸面用得到去抖，按 §2.7 不抽公共层）。
 */
const PAPER_DEBOUNCE_MS = 350;

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
 * 简历屏顶部分步引导的四步（resume chunk flow 片 4）：顺序就是两条用户流程——
 * 首次：①导入 → ②核对要素 → ③贴 JD 生成 → ④编辑导出；后续：直接 ③→④，①②保持可回查。
 * `sectionId` 既是 DeskSection 的持久开合键，也是点击跳转的目标；一颗事实不抄第二份（§2.5）。
 */
const RESUME_STEPS = [
  { sectionId: 'resume.doc', labelKey: 'desk.resume.step1' },
  { sectionId: 'resume.review', labelKey: 'desk.resume.step2' },
  { sectionId: 'resume.generate', labelKey: 'desk.resume.step3' },
  { sectionId: 'resume.output', labelKey: 'desk.resume.step4' },
] as const;

/** 「回查」那一排的页签名。三格互斥挂载：一次只挂一页，没选中那两页连读口与订阅都不养。 */
type ResumeRefTab = 'review' | 'issues' | 'output';

/**
 * 回查页签的三格（plan §1.2「一屏两件事」）：左列只留**当前在做什么**（①导入、③按岗位改写），
 * 其余三件都是"回头核对一眼"的东西，各占一页，不再一路平铺到脚——
 * ②素材逐块核对、待确认清单 + 事实素材（原先塞在①的正文里，裁定㉕ 第 3 条已经降过一级）、④出纸。
 * `sectionId` 沿用既有的段 id：既是 DeskSection 的持久开合键，也是 `resume-section-<x>` 那条取证通道，一字不改。
 * 「核对」那一页没有自己的段 id（它装的是两只 DeskExplainer，各自的 id 与 testid 跟着搬、不改名）。
 */
const RESUME_REF_TABS: readonly {
  tab: ResumeRefTab;
  sectionId: string | undefined;
  labelKey: string;
  icon: ComponentType<{ size?: number; className?: string }>;
}[] = [
  { tab: 'review', sectionId: 'resume.review', labelKey: 'desk.resume.refTabReview', icon: FileText },
  { tab: 'issues', sectionId: undefined, labelKey: 'desk.resume.refTabIssues', icon: ListChecks },
  { tab: 'output', sectionId: 'resume.output', labelKey: 'desk.resume.refTabOutput', icon: BookOpen },
];

/**
 * 段 id → 回查页签：分步引导点到②或④时先把对应那一页挂上，否则滚动目标根本不在 DOM 里（正文收起即卸载，
 * 而未选中的页签是整块不挂）。①③住在常驻列，不在这张表里。
 */
const REF_TAB_OF_SECTION: Record<string, ResumeRefTab> = {
  'resume.review': 'review',
  'resume.output': 'output',
};

/**
 * 取一条本机路径的**末段名字**（两个分隔符都吃：mac 的 `/` 与 Windows 的 `\`）。
 * @param filePath 人选中的那条绝对路径（只在函数里过一遍，不把全串摆上界面）
 * @returns 文件名那一段，用在导入回执里说"是哪一份"；末尾就是分隔符这类极端形状回空串
 */
function baseNameOf(filePath: string): string {
  const segments = filePath.split(/[/\\]/);
  return segments[segments.length - 1] ?? '';
}

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
 * ① 左右分栏——左列操作、右列一张纸常驻；② 模板走版式骨架缩略图网格（裁定㊲后住进整页编辑的右轨）；
 * ③ 预览 / PDF 查看两种画面共用同一纸面槽位、由键位进入（裁定㊳：原「排版」档与 PDF 的编辑能力都收进整页编辑）；
 * ④ 三颗开发夹具退出产品列、进「自测台」抽屉。
 *
 * 改造前的样子（病灶逐条在 plan §3.26 的表里）：`PANELS.resume` 平铺四块全宽面板、65 只键一列排到底，
 * `seed` / `seed-edited` / `fail` 与「导入 / 预览 / 导出」挤在同一行，预览 iframe 之前压着 330 行控件，
 * 而 50 套模板是一只看不见差别的 `<select>`。
 *
 * 状态归属：这一层是 `docId` / 模板 / 纸面档的**唯一持有者**（风险① 的对策），
 * 挂进来的 `GeneratePanel` 改吃 props；导出回执随写端一起搬进整页编辑的右轨（裁定㊲）。
 * 读数一律来自 `window.autoCC` 的既有白名单调用，界面不自己算（§2.5）。
 */
export function ResumeDesk() {
  const { t } = useTranslation();
  const bridge = window.autoCC;
  const [locale, setLocale] = useState<ResumeLocaleView>('zh-CN');
  /**
   * 右栏那张纸上此刻的内容——**desk 是唯一持有者**（§2.5）。
   * 只有一路来源：`preview` 档的 `resume.export.preview` 落库版；`pdf` 档画的是本机 PDF 文件本身，不吃这份 HTML。
   * `undefined` = 这一档此刻没有可画的那一张（槽位画空态，不画上一档的残留）。
   * 整页编辑那一屏的草稿画面归编辑页自己（它换掉整个工作台，不与这一格共用槽位，裁定㊲）。
   */
  const [paperHtml, setPaperHtml] = useState<string>();
  /** 纸角读数条（`paper-live`）的唯一依据：在途还是已最新。 */
  const [paperStatus, setPaperStatus] = useState<PaperStatus>('idle');
  /** 最近一次纸面落定的时刻（毫秒）；V 判据读它，不靠截图对比。 */
  const [paperUpdatedAt, setPaperUpdatedAt] = useState<number>();
  /**
   * "这张纸该重画了"的意图计数（spec 6.4-14）。左列四类改动都只写这一个数，
   * 由下面那条 effect 去抖成一趟跨进程渲染——于是"改动 → 画面"只有一条路径，
   * 而不是六颗键各调一次预览（那正是人必须自己按预览的原因）。
   */
  const [paperRevision, setPaperRevision] = useState(0);
  /** 在途那一趟的序列号：只有最新一次的响应能落进纸上，过期的直接丢（1200ms 预算下不丢会闪现旧纸）。 */
  const paperSeqRef = useRef(0);
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
  /**
   * 每份简历的**来路**（spec 4.1-14 / 裁定㉖ 第 3 条）：候选列表那一行小字唯一的数据源。
   * 与 `docs` 各读各的：`resume.doc.list` 只到摘要一层（id / 姓名 / 最后改动），
   * "它是哪份文件、什么时候导进来的"在 `resume_imports` 那张表里，只有 `resume.parse.provenance` 说得出。
   */
  const [provenance, setProvenance] = useState<ImportProvenanceRowView[]>([]);
  /** 正在等人二次确认要删掉的那一份（undefined = 确认框没开）。只存 id，界面不复制那份文档。 */
  const [pendingDelete, setPendingDelete] = useState<string>();
  /** 上一次删除失败的结构化错误（半删状态必须说得出为什么，且不把行从列表里摘掉，spec 6.4-20 的④）。 */
  const [deleteError, setDeleteError] = useState<AppErrorPayload>();
  /**
   * 可摆的模板清单（含版式骨架的七条轴）、当前用来出纸的那一套、人设定的那一套（3.2-03）。
   * 裁定㊲之后 desk 只**读**这一格（「当前样式：<名>」那一行 + 把 props 递给整页编辑），
   * 换样式与记默认的写端都搬进了编辑页的右轨——desk 里不再长出模板写入路径（§2.5）。
   */
  const [templates, setTemplates] = useState<ResumeTemplateSummaryView[]>([]);
  const [templateId, setTemplateId] = useState('classic');
  const [defaultTemplateId, setDefaultTemplateId] = useState('classic');
  const [lastImport, setLastImport] = useState<ImportReceiptView>();
  const [importError, setImportError] = useState<AppErrorPayload>();
  const [pending, setPending] = useState<PendingImportRowView[]>([]);
  /** 纸面槽此刻是哪一档（预览 / PDF 查看；裁定㊳后没有第三档，类型收窄）。 */
  const [paperMode, setPaperMode] = useState<ResumePaperMode>('preview');
  /**
   * 全屏整页编辑此刻是哪一屏（spec 3.10 / 裁定㉙ 第 2 条；2026-10-14 反转裁定后扩为三态）：
   * `model` 旧的内容与模板排版编辑，`pdf` WPS 形态纸面编辑器，`none` 工作台。
   * 三态**互斥挂载**而不是盖在上面：任何一屏都持有独立会话与画布，
   * 同一屏上两张纸会让 6.4-08 那条"槽里任何时刻只有一张画布"当场不成立。
   */
  const [editPageOpen, setEditPageOpen] = useState<'none' | 'model' | 'pdf'>('none');
  /** 09 稿形态⑥ 的那一跳：落点是简历屏时，「定制生成」那一格必须被强制打开（见 `DeskSection.openSignal`）。 */
  const trail = useViewTrail();

  /**
   * 分步引导的「跳进」信号（resume chunk flow 片 4）：每格 DeskSection 各认一个自增数，
   * 变了就强制展开该格——与 view trail 那一跳同机制（`useSectionOpen` 的 openSignal），不另造开关。
   * 键是段 id（`resume.doc` / `resume.review` / `resume.generate` / `resume.output`）；
   * 值是递增计数而不是时间戳：trail 跳来的 requestId 与点步骤条是两路来源，只有各自加一才能
   * 让两路都产生触发沿（取 max 会让小计数的 trail 被时间戳永久压住）。
   */
  const [stepSignals, setStepSignals] = useState<Record<string, number>>({});

  /**
   * 「回查」那一排此刻挂的是哪一页（plan §1.2：一屏只留两件事，其余进页签）。
   * 缺省停在②素材——库里有素材时那是进门后最常被回头看的一格；空库时它自己会给一句"先导入"。
   */
  const [refTab, setRefTab] = useState<ResumeRefTab>('review');

  /**
   * 页签那一格的「跳进」信号：与 `stepSignals` 同一机制（`useSectionOpen` 的 openSignal），
   * 换页时加一，让新挂上那一页里**被人收起过**的段重新展开——否则点页签只看到一个收起的段头，
   * 那一跳等于没发生。值取计数不取时间戳，理由与 `stepSignals` 那条相同。
   */
  const [refSignal, setRefSignal] = useState(0);

  /**
   * 换到回查的某一页（顺带把这一页里被人收起过的段重新展开）。
   * @param next 目标页签名。再点当前那一页同样涨一次信号：那是"点了必须有回应"的同一条判门（6.4-07），
   *   而不是空转——人刚收起段头再点页签，期待的是内容回来。
   */
  const switchRefTab = useCallback((next: ResumeRefTab): void => {
    setRefTab(next);
    setRefSignal((signal) => signal + 1);
  }, []);

  /**
   * 跳到某一步：目标住在页签里就先把那一页挂上，再把目标段强制展开（信号加一），下一帧滚到它的段头。
   *
   * 两帧的延迟是刻意的：信号写入 → DeskSection 的 effect 把收起态正文挂回 DOM（正文收起时是真卸载），
   * 同一帧里查询找不到节点。用双 rAF 等「信号落 state」与「正文挂载」两次提交走完。
   * @param sectionId 目标段 id
   */
  const jumpToSection = useCallback((sectionId: string): void => {
    // 换页那一跳只写 refTab、不涨 refSignal：落点段的展开由下面这一支 stepSignals 负责，不喂第二个开关。
    const pagedTab = REF_TAB_OF_SECTION[sectionId];
    if (pagedTab !== undefined) setRefTab(pagedTab);
    setStepSignals((previous) => ({ ...previous, [sectionId]: (previous[sectionId] ?? 0) + 1 }));
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>(`[data-testid="resume-section-${sectionId.slice('resume.'.length)}"]`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }, []);

  // 岗位行双击跳进简历屏（09 稿形态⑥）：那一跳也折成「③ 生成段」的一个信号沿，
  // 与步骤条共用同一支 openSignal，不给 DeskSection 喂第二个开关。
  const trailRequestId = trail?.targetView === 'resume' ? trail.requestId : undefined;
  useEffect(() => {
    if (trailRequestId === undefined) return;
    setStepSignals((previous) => ({
      ...previous,
      'resume.generate': (previous['resume.generate'] ?? 0) + 1,
    }));
  }, [trailRequestId]);

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
   * 重读待确认清单（spec 4.1-04）、每份简历的来路（spec 4.1-14）与库里的简历清单：
   * 导入落库、确认与删除都发生在主进程，界面不猜它当下的状态，
   * 所以每个动作结束后都调一次 `resume.parse.pending` + `resume.parse.provenance` + `resume.doc.list`（§2.5）。
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

  /**
   * 进门先问：能摆哪些模板（含骨架轴）、人上次设定用哪一套、以及库里已经有哪些简历**加上它们各自的来路**。
   * 只在挂载时问：这些都是库读数，屏内的动作要么自己写进 state，要么由 `read` 重读。
   *
   * 这里必须走 `read()` 而不是只 `refreshDocs()`：候选列表那一行小字（spec 6.4-18）吃的是
   * `resume.parse.provenance`，只问文档清单的话首屏每条来路都是空的，于是每个候选都会写成"没有导入记录"——
   * 那不是"读不到"，是**撒谎**（2026-10-10 活体首读就是在 10244 隔离实例上抓到这一条：
   * 同一条 37 版之前的老行，进门显示"没有导入记录"，随手导一份之后才显示"由本机导入（当时未记文件名）"）。
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
    })();
    // 文档清单 / 待确认 / 来路不跟模板偏好串行：模板枚举在冷 userData 上可能慢，
    // 简历清单不该被它堵在空态（活体 e2e 抓到切到简历视图十秒仍「库里还没有简历」）。
    void read();
  }, [bridge, read]);

  /**
   * 工作台切换是 `hidden` 显隐、不是卸载（App 1.10-01）：ResumeDesk 随应用启动就挂载，
   * 若简历是在别的视图（或桥通道）落库的，切回本视图时挂载 effect 不会再跑，清单就停在旧读数。
   * 于是每「重新可见」都重读一次——读数只以主进程当下状态为准（§2.5），不靠屏内事件凑刷新。
   */
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

  /**
   * 换纸面档。**判门只在这一处**：裁定㊳之后只剩「预览」与「PDF 查看」两档，
   * 两档都不吃当前文档之外的门槛（PDF 档打开后仍可空手挑文件），于是这里只留"重复点同一个页签就什么都不做"。
   * 换档同时**清空画面**：上一档的 HTML 留在槽里就会以另一档的身份挂在纸上（`preview` 档的落库版
   * 挂在「PDF 查看」页签下面，是 §2.5 禁止的那两份事实）；清空之后由那一条去抖 effect 重新供料。
   * @param next 目标档位
   */
  const requestPaperMode = (next: ResumePaperMode) => {
    if (next === paperMode) return;
    setPaperHtml(undefined);
    setPaperStatus('idle');
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
        // 清掉上一份的纸：新文档还没出过纸，留着的是一张挂着新身份的旧画面。
        setPaperHtml(undefined);
        // 首次使用流程：导入成功后自动展开并滚到「② 核对要素」（scanned 还停在待确认、尚未入库，不跳）。
        if (value.status === 'imported') jumpToSection('resume.review');
      },
      onError: setImportError,
      // 回执里印的是**人刚选中的那个文件名**，不是 `resume-1a2b`：这一句要说得出"是哪一份"，
      // 而此刻 `docs` 还没刷回来（spec 6.4-16 顺手修掉的那类违规就是往界面上印开发者标识）。
      describe: (value) =>
        value.status === 'scanned'
          ? t('resume.importScanned', { textLength: value.textLength })
          : value.isNew
            ? t('resume.importDone', {
                name: baseNameOf(target),
                format: t(FORMAT_LABEL_KEY[value.format]),
                textLength: value.textLength,
                count: value.issues.length,
              })
            : t('resume.importDup', { file: baseNameOf(target) }),
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
   * 删掉一份简历（spec 4.1-14 / 裁定㉖ 第 1 条）：一次跨进程调用，六张表里属于它的那几行在主进程的
   * **同一条事务**里消失，界面只摆服务带回的行数（§2.5：成功那句里的 N 段素材、M 条索引不是这里数的）。
   *
   * 三条形状约束：
   * ① 只从**二次确认框**里进来（`askDelete` 那一颗键负责开框），这颗键自己不决定删谁——
   *    确认框关掉之后 `pendingDelete` 已经清空，所以人手一抖按不到第二刀；
   * ② 删的是当前那份时**不写回** `docId`：`run` 收尾必然走 `read()` → `refreshDocs()`，
   *    那里已经有"当前那份不在列表里就落到下一份、列表空了就当作没有一份"这一条唯一判据（§2.5），
   *    纸面随之由那条去抖 effect 清空，于是"挂着已死身份的那张纸"在这一屏不可能出现；
   * ③ 失败时把主进程的错误码留在界面上，而**不**把行从列表里摘掉（库里本来就没动，读数回来还是那一行）。
   * @param targetDocId 确认框里那个人读过并点确认的那一份 id
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
    });

  /**
   * 打开删除的二次确认（spec 6.4-20）：这一刀删的是"这个人找工作用的全部素材"，比删一个模型配置重一个量级，
   * 所以不跟 `ModelSettingsPanel` 那一键直删的先例，必须让那句"连同素材一起删"先被人读到。
   * @param targetDocId 要删的那一份
   */
  const askDelete = (targetDocId: string) => {
    setDeleteError(undefined);
    setPendingDelete(targetDocId);
  };

  /**
   * 一份候选的**出处那一行**（裁定㉖ 第 3 条：每个候选一行小字）。
   *
   * 三种诚实形状，按库里有没有这一条来路、以及来路记没记住文件名分：
   * ① 有文件名 → 「来自 王二.pdf · 2026年10月9日 14:05 导入 · 读到 1842 字」；
   * ② 有来路但第 37 版之前没记文件名 → 照样给出时刻与字数，并明写"当时未记文件名"，
   *    **不回落成 hash 前缀、不拿姓名冒充**（4.1-14 的判据原文）；
   * ③ 压根没有来路行 → 只有自测台那颗种子键走这一支（它直接落库、从不写出处），所以写"演示内容"；
   *    真出现别的无来路文档也不能撒谎，另有一句"没有导入记录"。
   * @param targetDocId 这一行所属的候选 id
   * @returns 摆在那一行下面的小字（已翻译，不含任何开发者标识）
   */
  const provenanceLine = (targetDocId: string): string => {
    const line = provenance.find((row) => row.docId === targetDocId);
    if (line === undefined) {
      return targetDocId === DEMO_RESUME_DOC_ID ? t('resume.provenanceDemo') : t('resume.provenanceNoImport');
    }
    const time = new Date(line.importedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    return line.sourceName === null
      ? t('resume.provenanceNoName', { time, chars: line.textLength })
      : t('resume.provenanceFile', { file: line.sourceName, time, chars: line.textLength });
  };

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
        },
        describe: (value) => t('resume.seedReceipt', { docId: value.docId }),
      },
    );

  /**
   * 纸面的唯一供料口（spec 6.4-14）：`preview` 档里「这份文档 + 这套版式 + 这个语言 + 第几次改动」一变，
   * 就尾随去抖 350ms 发一次 `resume.export.preview`，与导出同一份打印 HTML 源（3.3-01「预览即导出所见」）。
   *
   * 三条形状约束，都是这一条要成立才让"预览"那颗键降级成手动补同步的凭据：
   * ① **只在 `preview` 档跑**——`pdf` 档画的是本机真实 PDF 文件，更不该被生成轨的 HTML 顶掉；
   * ② **不走 `run`**——`run` 收尾会调 `read`（重读待确认与库清单）并把 `busy` 挂上全屏，
   *    于是每滑一次滑杆就禁掉整屏的键；先例是编辑器会话那条不挂全屏 busy 的渲染注释（§2.5）；
   * ③ **序列号丢过期响应**——一次渲染在途时后面的改动会重新起一趟，回来的旧结果必须整条丢弃
   *    （`maxPreviewResponseMs` 那档预算下不丢就等于闪现旧纸，连改五次之后纸上看到的是第三次）；
   * ④ **去抖是尾随的**——每一次依赖变化都把上一趟还没起走的定时器 `clearTimeout` 掉，
   *    所以连改五只在最后发一趟真渲染（spec 6.4-14 的③数的是桥接调用次数，不是画面次数）。
   */
  useEffect(() => {
    if (paperMode !== 'preview') return;
    if (docId === undefined) {
      // 没有当前文档就没有这一张：清掉而不是留着上一份，否则身份读数与画面会各说各话。
      setPaperHtml(undefined);
      setPaperStatus('idle');
      return;
    }
    const seq = paperSeqRef.current + 1;
    paperSeqRef.current = seq;
    setPaperStatus('rendering');
    const timer = window.setTimeout(() => {
      void (async () => {
        const reply = await bridge?.resume['export.preview'](docId, templateId, locale);
        if (seq !== paperSeqRef.current) return;
        if (reply?.ok) {
          setPaperHtml(reply.value);
          setPaperUpdatedAt(Date.now());
        } else if (reply) {
          // 失败仍走 Banner（纸角那条只报"在途 / 已最新"两态，它不判成败）：这一张没重出来，
          // 纸上留的是上一版，所以这句原因必须上屏，不能只活在控制台里。
          setNotice(t('resume.paper.liveFailed', { message: reply.error.message }), 'seal');
        }
        setPaperStatus('idle');
      })();
    }, PAPER_DEBOUNCE_MS);
    // 依赖只列这六个语义输入：`t` 与 `setNotice` 故意不进来——换 app 界面语言不该重出这张纸
    // （纸上用哪种语言由 `resume-locale` 那一格自己管），而它们是每次渲染都可能换引用的壳，
    // 进依赖会让这条 effect 在无关事件上也重发一趟跨进程渲染（先例：编辑器会话挂载那条只吃 `docId`）。
    return () => window.clearTimeout(timer);
  }, [paperMode, docId, templateId, locale, paperRevision, bridge]);

  /**
   * 注入一次导出失败（对不存在的文档调 `toPdf`），让主进程的 `AppErrorPayload` 经同一个 `run` 外壳
   * 显示成可读中文——spec 3.3-11「注入失败 → 截图错误态，主进程不崩」的界面入口（自测台里的第三颗）。
   *
   * 裁定㊲把出纸的**正常**写端全部搬进了整页编辑（spec 3.13-01 的 C 半边），这一颗是唯一的例外并有意保留：
   * 它是"错误态能不能被看见"这条判据（3.3-11）的取证入口，目标硬接在 `FAILURE_DOC_ID` 上——
   * 它检验的不是"导出一份真简历"，而是"主进程返回 `AppErrorPayload` 时界面与主进程都不崩"。
   * 把它删了，3.3-11 就失去界面入口；把它改指当前文档，它就不再失败、 criterion 当场失效。
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
  const diffReason = fromId === '' || toId === '' ? 'SNAPSHOT_MISSING' : fromId === toId ? 'SNAPSHOT_SAME' : busyReason;

  /** 当前那份的身份读数（姓名读不到就露 id——宁可露 id 也不给一个空白纸）。 */
  const currentDoc = docs.find((doc) => doc.id === docId);
  const docLabel = currentDoc ? (currentDoc.name ?? currentDoc.id) : undefined;
  /** 确认框里那一份的身份读数：读不到姓名就写"没读出姓名的那一份"，**绝不把 docId 印给用户**（6.4-16 同源）。 */
  const deleteTarget = docs.find((doc) => doc.id === pendingDelete);
  const deleteTargetLabel = deleteTarget ? (deleteTarget.name ?? t('resume.pendingUnnamed')) : undefined;
  const templateName = templates.find((template) => template.id === templateId)?.name;

  /**
   * 候选列表那一份**排好归属**的行序，外加「能被定制的那几份」。
   *
   * 为什么界面自己排而不是照 `resume.doc.list` 的序直接map：那一列的序是"最后改动在前"，是全局读数；
   * 这一格要人一眼看清**归属**（裁定㉜：导入那份是母版，按 JD 定制出来的是它的派生物）。
   * 母版按原时刻序在上，各自的定制版紧跟其下、内部也按时刻序，所以只是把已有的 `parentDocId` 读出来分组，
   * 不引入第二份事实。母版已删而定制版还在的那些行排在末尾——它们仍在库里，也必须还能被删掉。
   */
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

  /**
   * 一支定制版下面那行小字：说清它是**为哪段 JD** 生成的、生成于何时（spec 4.11-16 的界面半边 / 裁定㊱）。
   * @param variant 库里的变体行（`parentDocId` 不为 null 的那一类）
   * @returns 已翻译的一行小字；标题读不到时明写"没记下标题"，绝不回落成 id 或姓名（6.4-16 同源）。
   *          时刻那格的格式化复用 `format.ts` 的 `formatClock`——它的"无时刻"替身在这里用不上，
   *          因为变体行的 `updatedAt` 总是存在（落库那一刻由调用方给）
   */
  const variantLine = (variant: ResumeDocSummaryView): string =>
    t('resume.docVariantLine', {
      jd: variant.jdLabel ?? t('resume.docVariantNoLabel'),
      time: formatClock(variant.updatedAt, ''),
    });

  /**
   * 「定制哪一份」那一栏的值：当前停在某支定制版上时回到它的母版。
   *
   * 为什么不是直接把 `docId` 递下去：变体不能再往下派生（血缘只许一层，主进程会挡），
   * 而人刚接受过一次改写、当前文档已经是那一支变体——这时下拉里若给的是变体 id，
   * 既对不上任何一个选项（候选只有母版），下一次「生成」也会撞在母版校验上。
   */
  const generateDocId = currentDoc?.parentDocId ?? docId ?? '';

  /**
   * "这张纸该重画了"：左列那些**不在上面六个依赖里**的改动（采纳一条改写、手动再同步一次）只写这一个意图，
   * 由上面那条 effect 去抖成一趟渲染。原先这里是"每处改动各自调一次 `renderPreview`"，
   * 于是同一屏有六条出纸的路径，而人不按预览就看不见结果（spec 6.4-14 要治的正是这一条）。
   */
  const bumpPaper = () => setPaperRevision((previous) => previous + 1);

  /**
   * 接受过一次改写之后，把"当前那一份"切到刚被写过的定制版并重画那张纸。
   *
   * 为什么切换而不是留在母版：改写从来不落到母版上（裁定㉜），留在母版的那张纸上人看不到任何结果，
   * 「已接受」就只是一行字。切过去以后整屏编辑、预览、导出都按这个 docId 现读，不需要第二条通道。
   * @param writtenDocId 接受写入的那一行 id（`GeneratePanel` 从主进程的接受读数原样递上来）
   */
  const adoptVariant = (writtenDocId: string) => {
    setDocId(writtenDocId);
    bumpPaper();
  };

  /**
   * 右栏的宽度（拖拽、键盘、双击、持久化全在 `ui/split.tsx` 那一处实现，spec 6.4-13）。
   * 与内核视图那一支共用原件而不是复刻一份，就是为了这里不必再写第二套越界夹取（§2.2/§2.5）。
   */
  const paperSplit = useSplitWidth<HTMLDivElement>({
    storageKey: PAPER_WIDTH_STORAGE_KEY,
    cssVar: PAPER_WIDTH_VAR,
    minPercent: PAPER_WIDTH_MIN,
    maxPercent: PAPER_WIDTH_MAX,
    stepPercent: PAPER_WIDTH_STEP,
    defaultPercent: PAPER_WIDTH_DEFAULT,
  });

  /**
   * PDF 查看这一轨的唯一模型（spec 3.5-12 / 裁定㊳）：控件长在左列、真纸画在右栏那一格，两边吃同一份 state。
   * 之所以把它挂在 desk 而不是面板里：一拆两格就有两个消费者，state 留在任何一边都会让另一份成第二份事实（§2.5）。
   * 裁定㊳之后这一轨只剩"看"：`pdf.io.open` 拿页数文件名、`pdf.io.bytes` 拿真纸，
   * 覆盖层/页序/另存那三条写端已整条摘除（编辑与出纸归整页编辑那一屏）。
   *
   * 曾经这里还有一条"进 PDF 档就自动导一份刚出的产物铺上纸"的 effect（用户 2026-10-12 报空白根因的补丁）：
   * 它的前提是"这一档吃当前文档"，而那个前提随导出写端一起搬走了——现在这一档从挑一份本机 PDF 开始，
   * 空的就画空态并教人选文件，不再拿一次隐式导出冒充"用户想看的那一份"。
   */
  const pdfView = usePdfView({ active: paperMode === 'pdf', onClose: () => requestPaperMode('preview') });

  /**
   * 「选择文件」那颗键（spec 6.4-19）：**在源码里只写一次**，却按段的开合只出现在一处 DOM——
   * 收起时它在段头下面那条常驻动作条里，展开时它在正文里。
   * 写成变量而不是两份 JSX，是因为 `data-action="pick-file"` 是 6.4-19 的取证通道地址：
   * 同一份 DOM 里长出两只，harness 就只能猜用户看见的是哪一只（§2.5「不允许两个都能用」）。
   * React 元素是不可变的描述，同一个变量在互斥的两条分支里引用不会让 DOM 翻倍。
   * 琥珀那一档说的是"往本机库里写一份"——不是外发，所以不给朱砂。
   */
  const pickFileButton = (
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
  );

  return (
    // 查询容器必须挂在**祖先**上：元素自己的 `container-type` 不作为自己的查询容器（CSS Containment 把
    // 查询对象限定为最近的祖先容器）。这一条是活体量出来的：容器挂在自己身上时首读 `flexDirection`
    // 仍是 `column`，而左栏（真·后代）已经摆好了。
    // 用 `@container` 而不是视口断点：右栏内核视图展开时主区只剩 486px，按视口量会误判成"够宽"
    // （与 `JobLabPanel` 同一口径，spec 6.4-04）。
    //
    // 换档点 **46rem = 736px**（spec 6.4-12；原先那一档是 77rem=1232，2026-10-10 被用户驳回：
    // 他的 1200 窗口里容器实测 940px，77rem 意味着"左右布局"在这台机器上永远不发生）。
    // 这一档同样是纸面给的算术，不是手感：**左列下限 320**（段头 + 一颗键 + 一行说明的最小可读宽度）
    // + **把手 6** + **栏间距 12** + **纸栏下限 400**（k≈0.47，还读得出双列还是单列）= **738**，
    // 断点取 736 那一格——差的 2px 由 `min-w-0` 吸收，活体在 736 档实测已进分栏（读数进 6.4-12）。
    // 77rem 那条算式之所以不再成立，是因为它隐含了"装不下就横向滚"这个前提；
    // 这一片把它换成**装不下就整张缩小**（`ResumePaperFrame` 的 `--paper-scale`，6.4-24 起再叠一条一页的高），
    // 纸的物理宽度 `w-[210mm]` 一字未改，所以"纸不许被裁"这件物理条件仍然成立（3.3-01 同源）。
    <>
      {/* 整页编辑那一屏（spec 3.10）：与工作台**互斥挂载**，而不是盖在上面或用 `hidden` 收起来——
          两个界面同时活着就是两份 `resume.editor.*` 会话（`open` 会互相放弃对方那份未保存的 draft），
          而"槽里任何时刻只有一张画布"（6.4-08）也只能靠卸载保证。
          画在 `@container` 外面：`container-type: inline-size` 隐含 `contain: layout`，
          画在里面时 `fixed` 后代就只能盖住简历区而不是整扇窗（与删除确认框同一条实测）。 */}
      {editPageOpen === 'model' && docId !== undefined ? (
        <ResumeEditPage
          docId={docId}
          templateId={templateId}
          locale={locale}
          docLabel={docLabel}
          templateName={templateName}
          templates={templates}
          defaultTemplateId={defaultTemplateId}
          onTemplateChange={setTemplateId}
          onDefaultTemplateChange={setDefaultTemplateId}
          onClose={() => setEditPageOpen('none')}
        />
      ) : editPageOpen === 'pdf' && pdfView.filePath.trim() !== '' ? (
        <PdfEditorPage filePath={pdfView.filePath.trim()} onClose={() => setEditPageOpen('none')} />
      ) : (
        <div className="@container min-w-0">
          <section data-testid="resume-panel" className="flex min-w-0 flex-col gap-3 @[46rem]:flex-row">
            {/* 左列：三步操作。宽度是**减出来的**（`flex-1`）而不是定死的——右栏那一格现在归人拖，
            对面若还是 400px 定宽，纸拖到 62% 时整行就会溢出（940 容器里 400+6+12+583=1001）。
            默认 56% 时这里量回 396px，与 6.4-07 那批读数的 400px 只差把手那 6px 的挤占。 */}
            <div className="order-2 flex min-w-0 flex-col gap-3 @[46rem]:order-1 @[46rem]:flex-1">
              {notice && (
                <Banner tone={noticeTone} markers={{ testid: 'resume-notice' }} className="break-all">
                  {notice}
                </Banner>
              )}

              {/* 分步引导条（片 4）：四步顺序固定，点击强制展开并滚到对应段。
            空库时②③④按不动并给出原因（先导入），①挂「从这步开始」；库里有素材后③挂「再次使用从这步开始」——
            生成段本身 defaultOpen，所以后续使用进门就能直接贴 JD，不必先碰①②。 */}
              <nav
                data-testid="resume-steps"
                aria-label={t('desk.resume.stepsHeading')}
                className="flex min-w-0 flex-wrap items-center gap-1 rounded-xl border border-line bg-ink-900/60 px-2 py-1.5"
              >
                <span className="text-[11px] text-slate-500">{t('desk.resume.stepsHeading')}</span>
                {RESUME_STEPS.map((step, index) => {
                  const isFirst = index === 0;
                  const isGenerateStep = step.sectionId === 'resume.generate';
                  const libraryEmpty = docs.length === 0;
                  const blocked = !isFirst && libraryEmpty;
                  const isEntryHint = (isFirst && libraryEmpty) || (isGenerateStep && !libraryEmpty);
                  return (
                    <span key={step.sectionId} className="flex items-center gap-1">
                      <DeskButton
                        action={`resume-step-${step.sectionId.slice('resume.'.length)}`}
                        variant="ghost"
                        compact
                        disabled={blocked}
                        disabledReason="resume-empty-library"
                        disabledReasonLabel={t('desk.resume.stepsEmptyReason')}
                        markers={{ step: String(index + 1) }}
                        onClick={() => jumpToSection(step.sectionId)}
                      >
                        <span className="text-[11px] text-slate-500">{String(index + 1)}</span>
                        {t(step.labelKey)}
                      </DeskButton>
                      {isEntryHint && (
                        <Tag tone="celadon" data-testid="resume-step-entry">
                          {libraryEmpty ? t('desk.resume.stepsFromStart') : t('desk.resume.stepsFromGenerate')}
                        </Tag>
                      )}
                    </span>
                  );
                })}
              </nav>

              {/* ① 挑一份简历（段名 2026-10-10 换成人话，spec 6.4-15）：库里那份 + 从本机导入那一步。
            原来独占一格的「事实核对」拆成两半各归其位——**没读准的地方**是这一步的产出，所以那一句提醒留在这里；
            素材与缺口是"回头要核对的东西"，不是一步，降到下面那一格披露层里（裁定㉕ 第 2 条）。
            `DeskSection` 的 `id` 是持久收起状态键，一个都不改（6.2-06 / 6.4-08 的取证通道地址）。 */}
              <DeskSection
                id="resume.doc"
                title={t('desk.resume.sectionDoc')}
                summary={docLabel ?? t('desk.resume.sectionDocEmpty')}
                defaultOpen
                openSignal={stepSignals['resume.doc']}
                markers={{ testid: 'resume-section-doc' }}
                headExtra={
                  // 裁定㉖ 第 2 条：收起态**只**把「选择文件」提到段头，别的都不提（提多了这一段就变成一整条工具栏）。
                  // 常驻的那一句是"当前是哪一份"——那句报障要的是"看得见这份是怎么来的、怎么删"，
                  // 所以这里给身份 + 入口，把候选列表与出处留在正文里（一收起就读完的那两件事）。
                  <DeskActionRow className="w-full">
                    <span className="min-w-0 flex-1 truncate text-[11px] text-slate-400">
                      {docLabel === undefined
                        ? t('desk.resume.sectionDocEmpty')
                        : t('desk.resume.sectionDocCurrent', { doc: docLabel })}
                    </span>
                    {pickFileButton}
                  </DeskActionRow>
                }
              >
                <div className="flex min-w-0 flex-col gap-2">
                  <p className="text-[11px] leading-relaxed text-slate-400" data-resume-step="doc">
                    {t('desk.resume.stepDocHint')}
                  </p>

                  {/* 候选列表（spec 6.4-18，**定向替换** 6.2-06 / 6.4-15 那一支 `DeskSelect` 的行形态）：
                  出处要"每个候选都看得见"，而下拉与列表是同一件事的两个入口（§2.5 不允许两个都能用），
                  所以下拉在这一格退场——`data-testid="resume-doc"` 与 `data-action="resume-doc"` 两条取证通道
                  跟着换形态、保留在承载它们的那只容器上（历史读数不重写，§4.5），行内选文档那颗键另起
                  `resume-doc-pick`，于是这一格仍然只有一处"可选文档的入口"。
                  生成通道那一格的「定制哪一份简历」下拉**不动**（它选的是目标，不是管文档）。
                  当前那一份用 `BLOCK_SELECTED_CLASS` 表状态而不是涂语气色：这一格同时可能有"在读 / 在改"，
                  两块色斑叠在一行就读不出了（6.2-20 那条纪律，`src/ui/**` 之外不许写 `bg-*-wash`）。 */}
                  <p className="text-[11px] text-slate-400">{t('resume.docLabel')}</p>
                  {docs.length === 0 ? (
                    <p className="text-[11px] text-slate-500" data-testid="resume-doc-none">
                      {t('desk.resume.sectionDocEmpty')}
                    </p>
                  ) : (
                    <ul
                      data-testid="resume-doc"
                      data-action="resume-doc"
                      data-current={docId ?? ''}
                      className="flex min-w-0 flex-col gap-1"
                    >
                      {docGroups.rows.map((doc) => {
                        const isCurrent = doc.id === docId;
                        const isVariant = doc.parentDocId !== null;
                        return (
                          <li
                            key={doc.id}
                            data-testid="resume-doc-row"
                            data-doc-id={doc.id}
                            data-parent-doc-id={doc.parentDocId ?? ''}
                            data-jd-label={doc.jdLabel ?? ''}
                            data-current={isCurrent ? 'true' : 'false'}
                            className={`flex items-start gap-1 rounded-lg border px-1.5 py-1 ${
                              isCurrent ? BLOCK_SELECTED_CLASS : 'border-line'
                            }${isVariant ? ' ml-3' : ''}`}
                          >
                            {/* 姓名读不到时写"没读出姓名的那一份"，与待确认那一行同一条口径（6.4-16：
                            用户可见的串里不许出现 id）；出处那一句永远单独一行，人不用点开任何东西就能看到它。 */}
                            <DeskButton
                              action="resume-doc-pick"
                              variant="ghost"
                              compact
                              className="min-w-0 flex-1 justify-start py-0.5 text-left"
                              markers={{ picked: isCurrent ? 'true' : 'false' }}
                              onClick={() => setDocId(doc.id)}
                            >
                              <span className="flex min-w-0 flex-col items-start gap-0.5">
                                <span className="flex w-full min-w-0 items-center gap-1.5">
                                  <span className="truncate text-xs text-slate-100">
                                    {doc.name ?? t('resume.pendingUnnamed')}
                                  </span>
                                  {isVariant ? <Tag>{t('resume.docVariantTag')}</Tag> : null}
                                  {isCurrent ? <Tag tone="celadon">{t('resume.docInUse')}</Tag> : null}
                                </span>
                                {/* 出处那一行与定制版那一行是两种来路：母版说"从哪个文件读来的"，
                                    定制版说"为哪段 JD 生成的、什么时候生成的"（裁定㉜ / ㊱）。 */}
                                <span className="w-full truncate text-[11px] text-slate-500">
                                  {isVariant ? variantLine(doc) : provenanceLine(doc.id)}
                                </span>
                              </span>
                            </DeskButton>
                            {/* 每一行都长出这颗键：那句「如何删除都不可见」要的不是一个隐藏手势，而是一个入口。 */}
                            <DeskButton
                              action="resume-delete"
                              variant="ghost"
                              compact
                              busy={busy === t('resume.delete')}
                              disabled={!!busy}
                              disabledReason={busyReason}
                              disabledReasonLabel={reasonLabel(busyReason)}
                              markers={{ docId: doc.id }}
                              onClick={() => askDelete(doc.id)}
                            >
                              <Trash2 size={12} />
                              {t('resume.delete')}
                            </DeskButton>
                          </li>
                        );
                      })}
                    </ul>
                  )}

                  {/* 主入口就是这颗键：选一份本机文件直接导入（裁定：绝对路径框降到"高级"里，不再是进门第一格）。
                它只在**展开态**出现在这里——收起态那一颗住在段头下面的常驻动作条里（见上面的 `headExtra`）。 */}
                  {pickFileButton}

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

                  {/* 删不动的那一句必须说得出**为什么**（主进程的错误码原样带上来），而且这一刻列表里那一行还在——
                库里没动，`read()` 回来的读数当然还在，这不是界面缓存（spec 6.4-20 的第 ④ 条）。 */}
                  {deleteError && (
                    <Banner tone="seal" markers={{ testid: 'resume-delete-error' }} className="break-all">
                      {t('resume.deleteError', { code: deleteError.code, message: deleteError.message })}
                    </Banner>
                  )}

                  {lastImport && (
                    <div className="flex flex-wrap items-center gap-1" data-testid="resume-import-sections">
                      {lastImport.sections.map((section, index) => (
                        <span
                          key={`${section.kind}-${index}`}
                          data-testid="resume-import-section"
                          className="rounded border border-line px-1 text-[11px] text-slate-400"
                        >
                          {section.kind === 'custom' && section.title.trim() !== ''
                            ? section.title
                            : t(`resume.kind.${section.kind}`)}{' '}
                          · {section.entries}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* 「待确认清单」与「改之前先看一眼」那两块原先塞在这一格正文的末尾（裁定㉕ 第 3 条已经降过一级），
                  本轮再降到下面「回查」那一排的**核对**页里去：它们是"回头核对一眼"的东西，不是导入这一步的产出，
                  摆在这里会让"当前在做什么"那一列一路平铺到脚（plan §1.2）。两块自己的 id 与 testid 一字不改地跟着搬。 */}
                </div>
              </DeskSection>

              {/* ② 核对要素（素材逐块）本轮搬进下面「回查」那一排的**素材**页：它不是"当前在做什么"，
                  而是"回头核对一眼"（plan §1.2）。段 id、testid 与条件挂载口径都跟着走，一字不改。 */}

              {/* ③ 按岗位改写：贴 JD、逐条决定采不采纳（段名换成人话，内容一字未动）。 */}
              <DeskSection
                id="resume.generate"
                title={t('desk.resume.sectionGenerate')}
                summary={
                  docLabel ? t('desk.resume.sectionGenerateFor', { doc: docLabel }) : t('desk.resume.sectionDocEmpty')
                }
                defaultOpen
                // 岗位行双击跳过来（trail effect 折成信号沿）与步骤条点③，共用这一支 openSignal。
                openSignal={stepSignals['resume.generate']}
                markers={{ testid: 'resume-section-generate' }}
              >
                <div className="flex min-w-0 flex-col gap-2">
                  <p className="text-[11px] leading-relaxed text-slate-400" data-resume-step="generate">
                    {t('desk.resume.stepGenerateHint')}
                  </p>
                  <GeneratePanel
                    docs={docGroups.masters}
                    docId={generateDocId}
                    onDocIdChange={setDocId}
                    refreshDocs={refreshDocs}
                    onAccepted={adoptVariant}
                  />
                  {/* 书写技能与必备信息清单（spec 4.9-10 / 4.9-11）挂在「按岗位改写」这一格：
                这一份指引就是这一趟改写带上的一张纸，人改完下一次就生效，中间没有别的开关。 */}
                  <SkillPanel docId={docId ?? ''} />
                </div>
              </DeskSection>

              {/* 「回查」那一排（plan §1.2「一屏两件事」）：上面两格是**当前在做什么**（①挑一份/导入、③按岗位改写），
              这里三页是"回头核对一眼"的东西，一次只挂一页。条件挂载而不是 `hidden`：没选中的两页连读口与事件订阅都不养
              （与下面 PDF 查看那一档同口径），而且隐藏态宽高为 0 会让同名选择器命中看不见的那一份（§9 的 5.4-b ⑦）。 */}
              <div
                data-testid="resume-ref-tabs"
                data-ref-tab={refTab}
                className="flex min-w-0 flex-col gap-2 rounded-xl border border-line bg-ink-900/60 px-2.5 py-2"
              >
                {/* 页签用 `DeskTab`（原件，§2.5 不另造一套）：那道 3×17 短线本来是贴在左轨边缘上的，
                横排时它落在每格自己的左缘——`nav` 因此留 8px 左内边距，短线才不出框。 */}
                <nav
                  aria-label={t('desk.resume.refTabsHeading')}
                  className="flex min-w-0 flex-wrap items-center gap-1 pl-2"
                >
                  {RESUME_REF_TABS.map((entry) => (
                    <DeskTab
                      key={entry.tab}
                      action={`resume-ref-${entry.tab}`}
                      view={entry.tab}
                      selected={refTab === entry.tab}
                      icon={entry.icon}
                      onClick={() => switchRefTab(entry.tab)}
                    >
                      {t(entry.labelKey)}
                    </DeskTab>
                  ))}
                </nav>

                {refTab === 'review' && (
                  /* ② 核对要素：导入拆块的逐块查看与修改（resume chunk flow 片 3）。
                  只对母版开放：选中变体时组件内部只给一句「去选母版」，写调用在主进程还有同一判据兜底。
                  openSignal 取两支之和（步骤条那一跳 + 换页那一跳）：两支都是只增不减的计数，
                  所以任一支动一下就产生一个触发沿，比取 max 少一条"小计数被大计数永久压住"的坑。 */
                  <DeskSection
                    id="resume.review"
                    title={t('desk.resume.sectionReview')}
                    summary={
                      docLabel ? t('desk.resume.sectionReviewFor', { doc: docLabel }) : t('desk.resume.sectionDocEmpty')
                    }
                    openSignal={(stepSignals['resume.review'] ?? 0) + refSignal}
                    markers={{ testid: 'resume-section-review' }}
                  >
                    <div className="flex min-w-0 flex-col gap-2">
                      <p className="text-[11px] leading-relaxed text-slate-400" data-resume-step="review">
                        {t('desk.resume.stepReviewHint')}
                      </p>
                      <ChunkReviewSection docId={docId} isVariant={currentDoc?.parentDocId != null} />
                    </div>
                  </DeskSection>
                )}

                {refTab === 'issues' && (
                  <div className="flex min-w-0 flex-col gap-2">
                    {/* 裁定㉕ 第 3 条：「待确认清单」是**一句只读提醒**——不加确认写口（那要新迁移 +
                    `resume['parse.ack']` + 白名单行，另立一片），也不删显示（它是"疑似扫描件：只读到 N 字"
                    唯一能被看见的信号，4.1-05）。点进去仍是那五类原因，逐字来自 `parse.pending`。 */}
                    {pending.length > 0 ? (
                      <DeskExplainer
                        id="resume.pending-issues"
                        label={t('resume.pendingCount', { count: pending.length })}
                        markers={{ testid: 'resume-pending-list' }}
                      >
                        <div className="flex min-w-0 flex-col gap-2">
                          <h3 className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-300">
                            <ListChecks size={14} />
                            {t('resume.pending')}
                          </h3>
                          <ul className="space-y-2">
                            {pending.map((row) => (
                              <li
                                key={row.sourceHash}
                                data-testid="resume-pending-row"
                                data-status={row.status}
                                className="rounded border border-line px-2 py-1.5"
                              >
                                {/* 这一行从前印的是 `{{docId}} · {{textLength}} 字`——开发者标识符摆到了用户面前
                                （spec 6.4-16 顺手修掉的那处违规）：换成姓名 + 处数 + 时刻。 */}
                                <p className="text-[11px] text-slate-400">
                                  {t('resume.pendingRow', {
                                    // 疑似扫描件**不入库**（4.1-05），所以这一行常常查不到姓名——那是它唯一的可见处。
                                    // 查不到就写"没读出姓名的那一份"，**绝不回落成 id**：回落等于把刚修掉的那串又印回去。
                                    name: docs.find((doc) => doc.id === row.docId)?.name ?? t('resume.pendingUnnamed'),
                                    issueCount: row.issues.length,
                                    time: new Date(row.updatedAt).toLocaleTimeString(),
                                  })}{' '}
                                  ·{' '}
                                  {row.status === 'scanned'
                                    ? t('resume.statusScanned', { chars: row.textLength })
                                    : t('resume.statusImported')}{' '}
                                  · {t(FORMAT_LABEL_KEY[row.format])}
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
                      </DeskExplainer>
                    ) : (
                      docId !== undefined && (
                        <p className="text-[11px] text-slate-500" data-testid="resume-pending-empty">
                          {t('resume.pendingEmpty')}
                        </p>
                      )
                    )}

                    {/* 「改之前先看一眼」是这一格披露层的名字（原 `resume.facts` 那一整段搬到此处，
                    spec 6.4-15 的 C 半边要求：`id` 与 `data-testid` 两个通道名一字不改地跟着走）。
                    条件挂载是刻意的：收起态下正文卸载，`KbPanel` 的订阅与 `read()` 就不跑——
                    这正是"不活跃时别养第二份工作副本"的口径（`usePdfView` 同形，spec 3.5-12）。 */}
                    <DeskExplainer
                      id="resume.facts"
                      label={t('desk.resume.sectionFacts')}
                      markers={{ testid: 'resume-section-facts' }}
                    >
                      <div className="flex min-w-0 flex-col gap-3">
                        <p className="text-[11px] leading-relaxed text-slate-400" data-resume-step="facts">
                          {t('desk.resume.stepFactsHint')}
                        </p>
                        {/* 两块既有面板只归位、不改逻辑（spec 6.3-03 的那条纪律在这一屏同样成立）；
                        `docId` 由 desk 单向推进来，人仍可在这格里改（spec 6.4-17）。 */}
                        <KbPanel docId={docId ?? ''} docLabel={docLabel} />
                        <GapPanel />
                      </div>
                    </DeskExplainer>
                  </div>
                )}

                {refTab === 'output' && (
                  /* ④ 出纸：当前样式读数 + 这张纸的出口键 + 快照对照（裁定㊲后模板架与导出写端都住进整页编辑）。 */
                  <DeskSection
                    id="resume.output"
                    title={t('desk.resume.sectionOutput')}
                    summary={
                      templateName
                        ? t('desk.resume.sectionOutputWith', { template: templateName, locale })
                        : t('desk.resume.sectionOutputNone')
                    }
                    defaultOpen
                    openSignal={(stepSignals['resume.output'] ?? 0) + refSignal}
                    markers={{ testid: 'resume-section-output' }}
                  >
                    <div className="flex min-w-0 flex-col gap-3">
                      <p className="text-[11px] leading-relaxed text-slate-400" data-resume-step="output">
                        {t('desk.resume.stepOutputHint')}
                      </p>

                      {/* 裁定㊲：模板架整块搬进整页编辑的右轨，这一格只剩**读数**——
                      「此刻出纸用的是哪一套样式」+「要换样式去哪里」。
                      写端（选中 / 记默认）在这里不再存在，同一屏不许有两条改样式的通道（§2.5）。 */}
                      <p className="text-[11px] text-slate-400" data-testid="resume-template-reading">
                        {templateName
                          ? t('desk.resume.styleCurrent', { name: templateName })
                          : t('desk.resume.styleCurrent', { name: templateId })}
                        {' · '}
                        {t('desk.resume.styleHint')}
                      </p>

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
                          onClick={bumpPaper}
                        >
                          <Eye size={12} />
                          {t('resume.preview')}
                        </DeskButton>
                        {/* 裁定㊲：出纸与换样式/记默认的写端整条搬进整页编辑的右轨，
                        且必须先落库再出纸（spec 3.13-05）——desk 这一侧不再持有"导一份还没存的纸"这条路。
                        预览是只读渲染，仍是这一格的键。 */}
                        {/* 整页编辑（spec 3.10-06）：判门是"要有当前文档"——编辑的是那一份的草稿，
                        没有文档就送进空会话（6.4-07 那句"页签点下去必须有回应"的同一条判门）。 */}
                        <DeskButton
                          action="open-edit-page"
                          variant="line"
                          compact
                          busy={!!busy}
                          disabled={noDocReason !== undefined}
                          disabledReason={noDocReason}
                          disabledReasonLabel={reasonLabel(noDocReason)}
                          onClick={() => setEditPageOpen('model')}
                        >
                          <Maximize2 size={12} />
                          {t('resume.edit.enter')}
                        </DeskButton>
                        {/* 裁定㊳：这一档只剩"看"——眼睛而不是铅笔，进的是本机 PDF 文件的查看轨。 */}
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
                          <BookOpen size={12} />
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
                )}
              </div>

              {/* 裁定㊲：排版编辑器（区块顺序、字号、行距、页边距那几条控件）整块搬进整页编辑，
                  desk 里不再挂那只排版编辑器——同一屏不许有两份草稿会话（§2.5），
                  而"改了滑杆要在那一格才看得见结果"的旧病灶也正是这一改的理由。 */}

              {/* PDF 查看这一档的**控件**（同一档的真纸在右栏那一格里，见 `PdfPaperView`）。
                  纯查看：只有挑文件、开路径、翻页，没有任何写口。
                  条件挂载是刻意的：隐藏态宽高为 0，同名选择器会命中看不见的那一份（§9 的 5.4-b ⑦）。 */}
              {paperMode === 'pdf' && <PdfViewPanel model={pdfView} onOpenEditor={() => setEditPageOpen('pdf')} />}

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

            {/* 右栏：一根把手 + 一张常驻的纸。两种看法（预览 / PDF 查看）都画在这一格里，
          所以"编排显示在右侧边栏"与"实时看到变动"是同一件事的两个说法（用户 2026-10-10 的原话）。
          窄档整栏换到最上面（`order-1`）：纵向退让时把纸摆在动作之前，主视觉不再被 330 行控件埋住（病灶③）；
          把手在这一档不画（堆叠时没有"左右"可拖），宽度那一档仍照常持久化，够到 46rem 就回到人拖的位置上。

          把手**挂在纸栏自己身上**（这一格的第一个孩子），而不是像 `KernelViewSlot` 那样挂在前一个兄弟上：
          那边必须出去是因为原生 `WebContentsView` 会盖住 aside 内的命中测试（8.8-04），这里没有那一层，
          留在内部才能让这一行只有一道 `gap`——三个平级的话 `gap-3` 会算出两道 12px，
          上面那条 320+6+12+400 的算术就不成立了。拖拽的宽度分母取的仍是**整行**
          （`ui/split.tsx` 里 `panel.parentElement`），不是这一格自己。

          `self-start` 是 sticky 生效的前提：flex 项默认被 `align-items: stretch` 拉成整行高（左列实测 2673px），
          拉满之后就没有可粘的余量——本轮活体拍到"滚到排版控件时右栏整格空白"正是这一条。 */}
            <div
              ref={paperSplit.panelRef}
              className="order-1 flex min-w-0 @[46rem]:sticky @[46rem]:top-0 @[46rem]:order-2 @[46rem]:w-(--resume-paper-width) @[46rem]:shrink-0 @[46rem]:self-start"
            >
              <SplitHandle
                split={paperSplit}
                label={t('desk.resume.paperHandle')}
                action="resume-paper-handle"
                testid="resume-paper-handle"
                className="hidden @[46rem]:block"
              />
              <div className="min-w-0 flex-1">
                <ResumePaperStage
                  mode={paperMode}
                  onModeChange={requestPaperMode}
                  paperHtml={paperHtml}
                  paperStatus={paperStatus}
                  paperUpdatedAt={paperUpdatedAt}
                  pdfView={<PdfPaperView model={pdfView} onOpenEditor={() => setEditPageOpen('pdf')} />}
                  docLabel={docLabel}
                  templateName={templateName}
                  locale={locale}
                  busy={!!busy}
                />
              </div>
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
                            {section.kind === 'custom' ? ` · ${section.sectionId}` : ''}
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
      )}
      {/* 删除的二次确认（spec 6.4-20）：这一刀删的是"这个人找工作用的全部素材"，
          与 `ModelSettingsPanel` 那一键直删的配置条目不是一个量级，所以必须读完整风险才点得下去——
          `dismissOnScrim: false` 一条 prop 同时关掉点遮罩 / Esc / 右上角 ✕ 三条退路（09 稿形态⑤）。
          渲染在 `@container` 那一格的**外面**，两条都是硬理由：
          ① `DeskSection` 收起时正文是卸载的，确认框不能跟着一起消失；
          ② `container-type: inline-size` 隐含 `contain: layout`，于是那一格会成为 `position: fixed` 后代的包含块——
             遮罩就只盖住简历区而不是整扇窗口，09 稿那条"同一时刻全 app 只有一只遮罩"的几何前提会当场不成立。 */}
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
          {/* 把"删掉哪些"与"留下哪些"分列写清：这一刀连素材一起删是裁定㉖ 第 1 条，
              而生成历史与额度台账留下是同一条裁定里另一半的表态——人不该靠猜知道边界在哪。 */}
          <ul className="list-disc pl-4 text-slate-300">
            <li>{t('resume.deleteRemoves')}</li>
            <li>{t('resume.deleteKept')}</li>
          </ul>
        </div>
      </Modal>
    </>
  );
}
