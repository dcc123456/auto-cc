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
import { useCallback, useEffect, useRef, useState } from 'react';
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
import { PdfPaperView } from './PdfPaperView';
import { ResumeEditor } from './ResumeEditor';
import { ResumePaperStage, type PaperStatus, type ResumePaperMode } from './ResumePaperStage';
import { TemplateShelf, type ResumeShelfFilter } from './TemplateShelf';
import { Banner, DeskButton, DeskField, DeskSelect, Tag } from './ui/controls';
import { DeskExplainer, DeskSection } from './ui/disclosure';
import { Drawer, useRevealLabel } from './ui/overlays';
import { SplitHandle, useSplitWidth } from './ui/split';
import { useBridgeAction } from './useBridgeAction';
import { usePdfEdit } from './usePdfEdit';
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
  /**
   * 右栏那张纸上此刻的内容——**desk 是唯一持有者**（§2.5）。
   * 来源两路且互斥：`preview` 档是 `resume.export.preview` 的落库版，`layout` 档是编辑器递上来的 draft。
   * `undefined` = 这一档此刻没有可画的那一张（槽位画空态，不画上一档的残留）。
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
   * 换档同时**清空画面**：上一档的 HTML 留在槽里就会以另一档的身份挂在纸上（`preview` 档的落库版
   * 挂在「排版」页签下面，是 §2.5 禁止的那两份事实）；清空之后由那一条去抖 effect 或编辑器重新供料。
   * @param next 目标档位
   */
  const requestPaperMode = (next: ResumePaperMode) => {
    if (next === 'layout' && docId === undefined) {
      setNotice(t('resume.reason.NO_CURRENT_DOC'), 'amber');
      return;
    }
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
   * 纸面的唯一供料口（spec 6.4-14）：`preview` 档里「这份文档 + 这套版式 + 这个语言 + 第几次改动」一变，
   * 就尾随去抖 350ms 发一次 `resume.export.preview`，与导出同一份打印 HTML 源（3.3-01「预览即导出所见」）。
   *
   * 三条形状约束，都是这一条要成立才让"预览"那颗键降级成手动补同步的凭据：
   * ① **只在 `preview` 档跑**——`layout` 档的纸由编辑器递 draft 上来，这里再发一次就把没保存的那份盖掉了
   *    （两份事实），`pdf` 档画的是真实文件的覆盖层，更不该被生成轨的 HTML 顶掉；
   * ② **不走 `run`**——`run` 收尾会调 `read`（重读待确认与库清单）并把 `busy` 挂上全屏，
   *    于是每滑一次滑杆就禁掉整屏的键；先例是 `ResumeEditor.refreshPreview` 那条注释（§2.5）；
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
    // 进依赖会让这条 effect 在无关事件上也重发一趟跨进程渲染（先例：`ResumeEditor` 挂载那条只吃 `docId`）。
    return () => window.clearTimeout(timer);
  }, [paperMode, docId, templateId, locale, paperRevision, bridge]);

  /**
   * 换一套版式：选中它。画面不用在这里显式重渲——`templateId` 是上面那条 effect 的依赖，
   * 换档自己会走那趟去抖（原先这里是"点一下模板调一次预览"，那正是"预览键是唯一入口"的形状）。
   * @param id 目标模板 id（来自 `resume.export.templates`，界面不自造）
   */
  const selectTemplate = (id: string) => setTemplateId(id);

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

  /**
   * "这张纸该重画了"：左列那些**不在上面六个依赖里**的改动（采纳一条改写、手动再同步一次）只写这一个意图，
   * 由上面那条 effect 去抖成一趟渲染。原先这里是"每处改动各自调一次 `renderPreview`"，
   * 于是同一屏有六条出纸的路径，而人不按预览就看不见结果（spec 6.4-14 要治的正是这一条）。
   */
  const bumpPaper = () => setPaperRevision((previous) => previous + 1);

  /**
   * 编辑器递上来的 draft：直接成为纸上这一刻的内容（`layout` 档里槽位自己不发起跨进程渲染）。
   * @param html draft 的打印 HTML；undefined = 这一版没渲出来，画空态而不是留着上一版冒充 draft
   */
  const acceptDraft = useCallback((html: string | undefined) => {
    setPaperHtml(html);
    if (html !== undefined) setPaperUpdatedAt(Date.now());
    setPaperStatus('idle');
  }, []);

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
   * PDF 覆盖这一轨的唯一模型（spec 3.5-12）：控件长在左列、真纸画在右栏那一格，两边吃同一份 state。
   * 之所以把它挂在 desk 而不是面板里：一拆两格就有两个消费者，state 留在任何一边都会让另一份成第二份事实（§2.5）。
   */
  const pdfEdit = usePdfEdit({ active: paperMode === 'pdf', onClose: () => requestPaperMode('preview') });

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
    // 这一片把它换成**装不下就整张缩小**（`ResumePaperStage` 的 `--paper-scale`），
    // 纸的物理宽度 `w-[210mm]` 一字未改，所以"纸不许被裁"这件物理条件仍然成立（3.3-01 同源）。
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

          {/* ① 挑一份简历（段名 2026-10-10 换成人话，spec 6.4-15）：库里那份 + 从本机导入那一步。
            原来独占一格的「事实核对」拆成两半各归其位——**没读准的地方**是这一步的产出，所以那一句提醒留在这里；
            素材与缺口是"回头要核对的东西"，不是一步，降到下面那一格披露层里（裁定㉕ 第 2 条）。
            `DeskSection` 的 `id` 是持久收起状态键，一个都不改（6.2-06 / 6.4-08 的取证通道地址）。 */}
          <DeskSection
            id="resume.doc"
            title={t('desk.resume.sectionDoc')}
            summary={docLabel ?? t('desk.resume.sectionDocEmpty')}
            defaultOpen
            markers={{ testid: 'resume-section-doc' }}
          >
            <div className="flex min-w-0 flex-col gap-2">
              <p className="text-[11px] leading-relaxed text-slate-400" data-resume-step="doc">
                {t('desk.resume.stepDocHint')}
              </p>

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

              {/* 裁定㉕ 第 3 条：「待确认清单」降级成**一句只读提醒**——不加确认写口（那要新迁移 37 +
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
                这正是"不活跃时别养第二份工作副本"的口径（`usePdfEdit` 同形，spec 3.5-12）。 */}
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
          </DeskSection>

          {/* ② 按岗位改写：贴 JD、逐条决定采不采纳（段名换成人话，内容一字未动）。 */}
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
            <div className="flex min-w-0 flex-col gap-2">
              <p className="text-[11px] leading-relaxed text-slate-400" data-resume-step="generate">
                {t('desk.resume.stepGenerateHint')}
              </p>
              <GeneratePanel
                docs={docs}
                docId={docId ?? ''}
                onDocIdChange={setDocId}
                refreshDocs={refreshDocs}
                onAccepted={bumpPaper}
              />
            </div>
          </DeskSection>

          {/* ③ 出纸：模板架（裁定② 的骨架缩略图）+ 这张纸的三把出口键 + 快照对照。 */}
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
              <p className="text-[11px] leading-relaxed text-slate-400" data-resume-step="output">
                {t('desk.resume.stepOutputHint')}
              </p>

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
                  onClick={bumpPaper}
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

          {/* 排版编辑器：只在「排版」这一档长出**控件**（区块顺序、字号、行距、页边距、语言），
            画面不跟着搬进来——它仍画在右栏那一格里（spec 6.4-14 的④：同一屏不许有两份草稿预览）。
            这是 2026-10-10 的一次形状更正：原先编辑器整块塞在纸面槽里（控件 + 它自己那张 iframe），
            于是"改了滑杆要在那一格才看得见结果"，而它与右边那张落库版预览同时挂在屏上。
            条件挂载而不是 `hidden`：隐藏态宽高为 0，同名选择器会命中看不见的那一份（§9 的 5.4-b ⑦）。 */}
          {paperMode === 'layout' && docId !== undefined && (
            <ResumeEditor docId={docId} onClose={() => requestPaperMode('preview')} onPreview={acceptDraft} />
          )}

          {/* PDF 覆盖这一档的**控件**（同一档的真纸在右栏那一格里，见 `PdfPaperView`）。
              与排版编辑器同一条形状：只有当前那一档在 DOM 里。 */}
          {paperMode === 'pdf' && <PdfEditPanel model={pdfEdit} />}

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

        {/* 右栏：一根把手 + 一张常驻的纸。三种看法（预览 / 排版 / PDF 覆盖）都画在这一格里，
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
              pdfView={<PdfPaperView model={pdfEdit} />}
              docLabel={docLabel}
              templateName={templateName}
              locale={locale}
              receipt={receipt}
              onReveal={revealReceipt}
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
