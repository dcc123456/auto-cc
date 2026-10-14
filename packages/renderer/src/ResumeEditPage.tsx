import {
  ChevronDown,
  ChevronUp,
  FileDown,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Redo2,
  Save,
  SlidersHorizontal,
  Undo2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  ExportReceiptView,
  ResumeLocaleView,
  ResumeSectionKindView,
  ResumeTemplateSummaryView,
} from '@auto-cc/shared';
import { editableToRaw } from '@auto-cc/plugin-resume-doc/richtext';
import { ResumeEditor } from './ResumeEditor';
import { ResumePaperFrame } from './ResumePaperFrame';
import { TemplateShelf, type ResumeShelfFilter } from './TemplateShelf';
import { Banner, DeskButton, DeskRange, DeskSegmented, DeskSwatch, deskReason } from './ui/controls';
import { useRevealLabel } from './ui/overlays';
import { useBridgeAction } from './useBridgeAction';
import {
  FONT_FAMILY_TOKENS,
  FONT_WEIGHT_TOKENS,
  INHERIT,
  METRIC_ROWS,
  OUT_OF_BOUNDS_REACH,
  SWATCH_HEXES,
  TEXT_ALIGN_TOKENS,
  dropIndexOfPointer,
  paragraphPatch,
  useResumeEditor,
} from './useResumeEditor';
import { armPaperBlocks, editableNodesOf, paperBlockOf, type PaperBlock } from './resume-paper-edit';

/** 样式条的名义宽度（clamp 落点时用来自证右缘不越窗）。 */
const STYLE_BAR_WIDTH_PX = 560;

/** 样式条与那一段之间留的缝隙（px），以及贴在窗顶之下多少才算"放得下"。 */
const STYLE_BAR_GAP_PX = 10;
const STYLE_BAR_TOP_FLOOR_PX = 96;

/**
 * 注进纸面帧里的那一小段样式（编辑中的那一格 + 选中那一段 + 拖拽落点那一格）。
 *
 * 为什么在帧内注一条规则而不是在父页盖一层描边：纸是被 `scale` 缩放过的，父页那一层要跟着每帧重算矩形，
 * 而段落在**帧内**的矩形天然就是排版后的真实位置。这一条只描边、不改排版（`outline` 不占布局盒），
 * 所以它进不了导出产物——导出走的是主进程那份 HTML，与界面里这一个运行期节点无关（spec 3.10-02 的读数）。
 * 3.12 换的形状：`caret-color` 那一档是给纸上那一格落光标用的（编辑态就在纸上，不再有盖在上面的框），
 * 而 `outline:none` 是**关掉浏览器自己那一圈** `:focus-visible` 的黑粗线——它在纸上像一块补丁，
 * 描边改由 `.rz-edit-focus` 画（spec 3.12-04）。
 */
const PAPER_EDIT_STYLE = [
  '[data-rz-section]{cursor:pointer}',
  '[data-rz-field]{cursor:text}',
  '[contenteditable="true"]{outline:none;caret-color:#a31621}',
  '[contenteditable="true"].rz-edit-focus{outline:1px solid #0b5c50;outline-offset:2px}',
  '[data-rz-section].rz-edit-selected{outline:2px solid #a31621;outline-offset:3px}',
  '[data-rz-section].rz-edit-drop{outline:2px dashed #0b5c50;outline-offset:-2px}',
].join('');

/** 指针按下到抬起之间，算"拖过"的位移门槛（px）：低于它按**点选**处理，不发任何跨进程调用。 */
const DRAG_THRESHOLD_PX = 4;

/** 一格的写入坐标换成一个可比的字符串（同格之内的焦点移动不算"离开那一格"）。 */
const blockKeyOf = (target: PaperBlock): string => `${target.sectionId}/${target.entryId}/${target.fieldKey}`;

/** 正在编辑的那一格的凭据：写入坐标 + 原文 + 承字节点 + 进编辑态之前的 HTML。
 *
 * **不存草稿**：纸上的 DOM 就是草稿本身（父页驱动 `contenteditable`，spec 3.12-04），
 * 界面手里再存一份文本就是第二份事实，还会与纸上不同步（§2.5）。
 * `snapshot` 只为 Esc 那一条存在：取消要把那一格**逐字放回**进编辑态之前的形状（3.12-09）。
 */
interface HeldBlock extends PaperBlock {
  /** 坐标换成一个可比的字符串：同格之内的焦点移动不算"离开那一格"。 */
  key: string;
  snapshot: string;
  /** 人已按 Esc 收回这一格：焦点离开时只清状态，一个字节都不发。 */
  isCanceled: boolean;
  /**
   * 人在这一格里**真的动过字**吗（帧内派过一次 `input`）。
   * 只比摘回来的原文与文档里那一格是不够的：文档存的写法可能不是文法的**规范形**
   * （多余空行、三级缩进、落单的 `**`），那样"点进去看一眼再点出来"就会被判成改动，
   * 于是界面替人把那一格悄悄重排成另一种写法（spec 3.12-05：没动过就一个字都不发）。
   */
  hasEdited: boolean;
}

/**
 * 纸面帧当下的缩放倍率与它在视口里的原点。
 * @param frame 纸面帧节点
 * @returns `{ scale, originLeft, originTop }`；帧还没量出宽度时回 `undefined`（不拿猜的坐标去钉东西）
 */
function paperScaleOf(frame: HTMLIFrameElement): { scale: number; originLeft: number; originTop: number } | undefined {
  const rect = frame.getBoundingClientRect();
  const naturalWidth = frame.offsetWidth;
  if (naturalWidth < 1) return undefined;
  return { scale: rect.width / naturalWidth, originLeft: rect.left, originTop: rect.top };
}

/**
 * 整页直接编辑 = 唯一的工作台（spec 3.10 / 3.12 / **3.13 裁定㊲**，plan §3.35 的"一张纸 + 两条轨"）。
 *
 * **这一屏对着纸改两件事**：排版（点一段 → 那一段的字号 / 行距 / 对齐 / 字重 / 字色 + 上移下移，
 * 文档级的基准字号 / 行距 / 四边距在右轨）与正文（**纸上那一格就是输入口**：
 * 点一下落光标、直接敲、离开那一格就进工作副本，界面上没有第三只框、也没有确认键，spec 3.12 / 裁定㉠）。
 * 敲进去的字只进简历工作副本，知识库要靠原来那颗「同步」；改了也不直接进库，还要按「保存」（裁定㉚）。
 * 这一屏上不画任何"点了没反应"的假控件（§2.6）。
 *
 * 裁定㊲ 之后这一屏**新增长着两条轨**（06 plan §3.35）：
 * - **左轨管"内容"**（区块清单 / 条目拆并，就是那份纯表现层的 `ResumeEditor`），可收起——
 *   收起走**条件挂载**：收起态下那一份展开的控件根本不在 DOM 里，不是 `hidden` 叠放（§9 的 5.4-b ⑦，
 *   零宽高的同名选择器会命中看不见的那一份）；
 * - **右轨管"呈现与出货"**（样式网格 + 整份文档的度量 + 默认样式 + 导出键），常开。
 *   导出、脏态读数、导出回执在右轨底部**三点一线**（6.4-25 的③：不许让人去别的界面找回执）。
 *
 * 四条形状约束（裁定㊲ 后修订）：
 * ① **画面仍出自同一个 builder**——纸上是 `resume.editor.preview` 返回的那份 draft HTML，
 *    与导出产物同一份源（3.3-01 在这屏继续成立），这里没有第二套简历渲染器（§2.5）；
 * ② **命中与编辑态都在父页一侧做**——帧是 `sandbox="allow-same-origin"`（**不放开** `allow-scripts`），
 *    帧内不跑脚本，父页读它的 DOM、给那一格挂 `contenteditable`、把监听挂在帧文档上（plan §17 的实测表）；
 * ③ **格式只由主进程那一份文法解释**——离开那一格时把纸上的形状摘成语法树交给 `editableToRaw`，
 *    渲染层不认识 `- ` 与 `**`（3.12-03）；
 * ④ **会话只有一份，且只长在这一屏**——左轨的表现层控件全部吃这一屏传入的 `session`（同一条撤销栈，
 *    spec 3.10-07 / 3.13 裁定㊲：desk 上不再挂编辑器，也没有第二份会话可漂）。
 * @param docId 要编辑的那份文档（**归属仍由 desk 持有**——纸面预览 `resume.export.preview` 吃同一份身份，
 *   且两屏互斥挂载；这一屏只消费，不自造第二份 docId state）
 * @param templateId 架上选中的版式（归属同上；**这一屏绝不自己长一份模板 state**，§2.5。
 *   写端在本屏：样式网格点一套 → `onTemplateChange` 回写 desk 那一份，`useResumeEditor` 的对齐效应
 *   随即补一次 `editor.use` 换预览，下一次导出也带这一套——切样式只剩这一条路（3.13-04））
 * @param locale 架上选中的预览语言
 * @param docLabel 身份读数（姓名读不到就露 id）
 * @param templateName 版式展示名
 * @param templates 可摆的模板清单（desk 那一趟 `resume.export.templates` **只读**的落点，整份递进来）
 * @param defaultTemplateId 人设定的默认那套 id
 * @param onTemplateChange 把架上选中的版式改成这一套（回写 desk 的唯一 setter）
 * @param onDefaultTemplateChange 默认那套已写进库时的回写（`export.setPreference` 成功后才调）
 * @param onClose 退出这一屏（dirty 时先走屏内的确认）
 */
export function ResumeEditPage({
  docId,
  templateId,
  locale,
  docLabel,
  templateName,
  templates,
  defaultTemplateId,
  onTemplateChange,
  onDefaultTemplateChange,
  onClose,
}: {
  docId: string;
  templateId: string;
  locale: ResumeLocaleView;
  docLabel?: string;
  templateName?: string;
  templates: readonly ResumeTemplateSummaryView[];
  defaultTemplateId: string;
  onTemplateChange: (id: string) => void;
  onDefaultTemplateChange: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const bridge = window.autoCC;
  const [paperHtml, setPaperHtml] = useState<string>();
  /** 每一帧装好后收回来的那一个 iframe（命中测试与选中描边都挂在它的文档上）。 */
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  /**
   * 纸重出过几次。**每一次 `srcdoc` 换内容都会换掉整个帧内 Document**，挂在旧文档上的监听随之失效——
   * 所以装载次数必须进那两条 effect 的依赖，不然"改一次字号之后纸翻面，此后点什么都不长条"（活体会踩到）。
   */
  const [paperNonce, setPaperNonce] = useState(0);
  /** 选中那一段的 id（种类从投影里现查，不在这里存第二份区块表，§2.2）。 */
  const [selectedId, setSelectedId] = useState<string>();
  /**
   * 正在编辑的那一格的**坐标读数**（`undefined` = 没有在敲）。
   * 它是这一屏唯一的一份"编辑态"事实：样式条据此收起（描边不能盖在人正在敲的那一行上），
   * 而**内容**不在这里存——纸上的 DOM 就是当下那一份（`heldRef` 只留节点与快照，§2.5）。
   */
  const [editingKey, setEditingKey] = useState<string>();
  /** 当下那一格的凭据（跨拍要现问：监听只挂一次，见 `liveRef`）。 */
  const heldRef = useRef<HeldBlock | undefined>(undefined);
  /** 样式条的落点（视口坐标，px）：写成 CSS 变量而不是 `style={}`（§5.1，与 `--paper-scale` 同一口径）。 */
  const barRef = useRef<HTMLDivElement | null>(null);
  /** 纸所在的那一格是这一屏的滚动容器：滚动要把样式条跟着挪或收起。 */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  /**
   * 这一次进屏有没有**真的发出过**一次打字（判据见 `flushHeld`：与原文相同就不发，所以发出必改动）。
   * 「退出这一屏」那一条确认不能只看 `view.isDirty`——交回打字与抬起手指点中退出键只隔一个往返，
   * 那一刻投影里还是旧值，只看它就会把刚敲的字连着会话一起丢掉（spec 3.12-05）。
   */
  const hasTypedRef = useRef(false);
  /**
   * 左轨（内容）在不在场。**条件挂载**的唯一开关：收起态下展开那份整体从 DOM 里消失，
   * 只留一条 24px 的把手（06 plan §3.35 决定 1；`hidden` 叠放会撞 §9 的 5.4-b ⑦ 同名选择器陷阱）。
   */
  const [contentRailOpen, setContentRailOpen] = useState(true);
  /** 样式网格的筛选（纯界面状态：这一屏自己收放、翻页不该把人筛掉的东西偷偷放回来）。 */
  const [shelfFilter, setShelfFilter] = useState<ResumeShelfFilter>({});
  /** 这一次进屏导出的回执（右轨底部那条，3.13-05 的"回执与动作同视野"）。 */
  const [exportReceipt, setExportReceipt] = useState<ExportReceiptView>();

  /**
   * 这一屏是**唯一的会话持有者**（裁定㊲）：左轨的 `ResumeEditor` 吃这里递下去的 `session`，
   * 屏自己的样式条与右轨度量栏也吃同一份投影、同一条撤销栈（spec 3.10-07）。
   */
  const session = useResumeEditor({ docId, templateId, locale, onPreview: setPaperHtml });
  const {
    view,
    rejected,
    busy,
    notice,
    noticeTone,
    setMetric,
    applyDesign,
    moveSection,
    setFieldText,
    stepHistory,
    save,
  } = session;

  /**
   * 「出货」那一手的独立外壳（默认样式 + 导出 PDF 这两个**写端**，裁定㊲ 第 2/3 条把它们从 desk 搬了进来）。
   * 走既有的 `useBridgeAction` 通道——回执那句"这一次顺带落了库"就落在它的 `notice` 上，
   * 不新造提示机制（§2.2）；它的读数就是这份 paper 状态本身，动作收尾无需再发一次桥调用（`usePdfView` 同形）。
   */
  const shipRead = useCallback(() => Promise.resolve(), []);
  const { busy: shipBusy, notice: shipNotice, noticeTone: shipNoticeTone, run: runShip } = useBridgeAction(shipRead);
  const revealLabel = useRevealLabel();

  /** 当前那一段（从投影里查：撤回到没有它的状态时样式条自己消失，不拿着旧种类继续发）。 */
  const selected = view?.sections.find((section) => section.id === selectedId);

  const busyReason = busy !== undefined ? 'ACTION_BUSY' : undefined;
  const { dead, label: reasonLabel, reason: afterBusy } = deskReason(t, 'resume.editor', busyReason);
  const undoReason = afterBusy(!view?.canUndo, 'NOTHING_TO_UNDO');
  const redoReason = afterBusy(!view?.canRedo, 'NOTHING_TO_REDO');
  const saveReason = afterBusy(!view?.isDirty, 'NOTHING_TO_SAVE');
  const selectedIndex = view?.sections.findIndex((section) => section.id === selectedId) ?? -1;
  const moveUpReason = afterBusy(selectedIndex <= 0, 'AT_FIRST_SECTION');
  const moveDownReason = afterBusy(
    selectedIndex < 0 || selectedIndex >= (view?.sections.length ?? 0) - 1,
    'AT_LAST_SECTION',
  );
  /** 出货那一手的在途判门：会话或写端任一在途，导出/设默认都轮不到人再按（原因码与全屏共用那一句）。 */
  const shipBusyReason = busy !== undefined || shipBusy !== undefined ? 'ACTION_BUSY' : undefined;
  /** 样式网格的按不动：清单还没读回来时整架按不动（6.2-06 的码与话成对，这话住在 `resume.reason.*`）。 */
  const shelfPendingReason = templates.length === 0 ? 'TEMPLATE_LIST_PENDING' : undefined;

  /**
   * 导出 PDF：**先落库再出纸**（3.13-05 / plan §19.4 第 1 条，裁定㊲ 的第 2 条写端）。
   *
   * 两个反例都不许出现：脏时把导出键禁用（"改了反而不能导"是反的——这里**只看有没有在途**，
   * 不看 dirty），或跳过落库直接导旧稿（产物与纸上所见不一致，破 3.3-01）。
   * 干净文档调 `save` 也无妨：主进程那趟是幂等的重写，不产失败（3.13-05 的 V：不改字直接导出，
   * 保存态不许变成"保存失败"）。保存那一趟**真落了库**才发导出——`save()` 的成功位就是为这一条留的。
   * 回执走 `runShip` 的既有提示通道，落在右轨里与导出键、脏态读数同一视野（6.4-25 的③）。
   */
  const exportPdf = () => {
    void (async () => {
      const saved = await save();
      if (!saved) return;
      await runShip(t('resume.export'), () => bridge?.resume['export.toPdf'](docId, templateId, locale), {
        apply: (value) => setExportReceipt(value),
        describe: (value) => t('resume.edit.template.exportDone', { pages: value.pages, bytes: value.bytes }),
      });
    })();
  };

  /**
   * 把人设定的默认样式写进库（`resume.export.setPreference`，从 desk 搬进来的第二个写端，3.13-04）。
   * 未知 id 由主进程拒绝，界面不自己判模板存在性（§2.5）；成功后回写 desk 那一份 `defaultTemplateId`——
   * 归属不变，这里只是那只唯一的手。
   */
  const rememberTemplate = () =>
    void runShip(t('resume.setTemplate'), () => bridge?.resume['export.setPreference'](templateId), {
      apply: () => onDefaultTemplateChange(templateId),
      describe: () => t('resume.edit.template.defaultDone', { name: templateName ?? templateId }),
    });

  /** 把刚导出的那份产物在系统文件管理器里选中（`shell.revealInFolder`，6.2-12 的第二段动作，锚点随回执搬进来）。 */
  const revealReceipt = () =>
    void runShip(revealLabel, () => bridge?.shell.revealInFolder(exportReceipt?.path ?? ''), {
      describe: () => undefined,
    });

  /**
   * 动作与状态的**当下引用**：拖拽与编辑都跨好几拍，抬起/离开那一刻要读最新的 `moveSection` / `setFieldText`，
   * 而监听挂的是帧内文档（重挂一次就把整趟拖拽与正在敲的那格打断），所以经这一只 ref 现问而不是把监听重挂一遍。
   */
  const liveRef = useRef({ moveSection, setSelectedId, setFieldText });
  useEffect(() => {
    liveRef.current = { moveSection, setSelectedId, setFieldText };
  });

  /**
   * 交回正在编辑的那一格（spec 3.12-05「离开那一格发且仅发一次」）。
   *
   * **先收状态再发**：从一格跳到另一格时，`focusout` 与 `focusin` 是连着派的，
   * 手里若还留着旧格子，同一次移动可能交回两次。
   * 摘树走 `editableToRaw`（主进程那一份文法的反向，3.12-01），界面不认识 `- ` 与 `**`（§2.5）。
   * **两道闸各自的含义不同**：按过 Esc（那一支已把 HTML 放回快照）不发；这一格没派过 `input` 也不发
   * ——后一道是**必需**的，因为文档里存的值可能不是文法的规范形（多余空行、三级缩进、落单的 `**`），
   * 只比内容就会把"点进去看一眼"变成"界面替人把那一格悄悄重排"（plan §18 落地补充第 2 条）。
   * "改了又改回去"那一种留给主进程的 `contentHash` 判（3.11-02），界面不写第二份相等判据（§2.5）。
   */
  const flushHeld = useCallback(() => {
    const held = heldRef.current;
    if (!held) return;
    heldRef.current = undefined;
    setEditingKey(undefined);
    held.node.classList.remove('rz-edit-focus');
    if (held.isCanceled || !held.hasEdited) return;
    hasTypedRef.current = true;
    liveRef.current.setFieldText(
      held.sectionId,
      held.entryId,
      held.fieldKey,
      editableToRaw(editableNodesOf(held.node)),
    );
    // 依赖只有这一份：只读 ref 与稳定 setter，所以监听 effect 不会因为父页重渲而重挂（§2.5 一份事实一条路径）。
  }, []);

  /** 帧每装好一次：记下节点并把装载次数加一，让下面两条 effect 在**新文档**上重挂一遍监听。 */
  const onPaperLoad = useCallback((node: HTMLIFrameElement) => {
    setFrame(node);
    setPaperNonce((nonce) => nonce + 1);
  }, []);

  /**
   * 把样式条钉在选中那一段的**上方**（放不下就钉在下方），位置写成 CSS 变量。
   * 倍率不在这里重算：`rect.width / offsetWidth` 就是当下那一档（父页的 `scale` 是唯一的一份事实，§2.5）。
   */
  const placeBar = useCallback(() => {
    const bar = barRef.current;
    const paper = frame;
    const paperDoc = paper?.contentDocument;
    // 逐节比对属性而不是把 id 拼进选择器：id 是主进程生成的串，拼进 CSS 字符串就是把两种事实并成一条（§2.6）。
    const node =
      paperDoc && selectedId
        ? Array.from(paperDoc.querySelectorAll('[data-rz-section]')).find(
            (item) => item.getAttribute('data-rz-section') === selectedId,
          )
        : null;
    if (!bar || !paper || !node) return;
    const measured = paperScaleOf(paper);
    if (!measured) return;
    const { scale, originLeft, originTop } = measured;
    const hit = node.getBoundingClientRect();
    const top = originTop + hit.top * scale;
    const height = hit.height * scale;
    const below = top < STYLE_BAR_TOP_FLOOR_PX;
    const left = Math.min(
      Math.max(8, originLeft + hit.left * scale),
      Math.max(8, window.innerWidth - STYLE_BAR_WIDTH_PX - 8),
    );
    bar.style.setProperty('--rz-bar-x', `${Math.round(left)}px`);
    bar.style.setProperty(
      '--rz-bar-y',
      `${Math.round(below ? top + height + STYLE_BAR_GAP_PX : top - STYLE_BAR_GAP_PX)}px`,
    );
  }, [frame, paperNonce, selectedId]);

  // 选中变了、纸换了、窗口动了、格子滚了——样式条要跟着重钉一次。
  // 打字态不需要这一趟：纸上的那一格就是输入口，光标落点由帧内文档自己管（裁定㉠）。
  // 用 `useLayoutEffect`：钉条的量法要读帧内矩形，画之前先钉好才不会闪一帧错位。
  useLayoutEffect(() => {
    placeBar();
    const slot = scrollRef.current;
    const onScroll = () => placeBar();
    slot?.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      slot?.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [placeBar]);

  /**
   * 纸面帧装载好之后：注一条选中样式、把**每一格**武装成输入口、把监听挂在**帧内文档**上。
   *
   * 监听挂在 `pointerdown` 当场（与左列拖拽同一条活体教训：`harness drag` 的 up 在 effect 跑之前就过去了）。
   *
   * 三件事各归一处，互不打断：
   * ① 按在**格子之内**（带 `data-rz-field`）——只把选中落到那一段，**不** `preventDefault`、**不**起拖拽，
   *    剩下的交给浏览器：光标落点、选中词、双击选句、IME 候选窗都是原生行为（spec 3.12-05 / 3.12-10）；
   * ② 按在格子之外（段落的空白处、标题、日期那些没有写入坐标的地方）——这才是**换顺序**的手势：
   *    位移过门槛抬起时发一次 `resume.editor.move`，没拖过就只**选中**（长出样式条，3.10-05 不变）；
   * ③ 焦点进出一格由 `focusin`/`focusout` 管：进格记下凭据与快照，出格把形状摘成原文交回**一次**
   *    `resume.editor.text`（3.12-05 的"发且仅发一次"）。
   *
   * 每帧都要重新武装：`srcdoc` 换内容会换掉整个帧内 Document，上一帧挂的 `contenteditable` 随之消失。
   */
  useEffect(() => {
    const paperDoc = frame?.contentDocument;
    if (!paperDoc) return;
    // 这一份是**新** Document：`focusout` 在文档被换掉时**不会**派，上一帧那一格的凭据若还留在手里，
    // 下一次点进同一个 `fieldKey` 就会被下面那句"同一格不算离开"的早退挡掉——
    // 于是新格没快照、交回时摘的还是那棵已脱离文档的旧树（字就这么静默丢了）。
    heldRef.current = undefined;
    setEditingKey(undefined);
    const style = paperDoc.createElement('style');
    style.textContent = PAPER_EDIT_STYLE;
    paperDoc.head.appendChild(style);
    armPaperBlocks(paperDoc);
    const sectionNodes = () => Array.from(paperDoc.querySelectorAll('[data-rz-section]'));
    const clearMarks = () => {
      for (const node of sectionNodes()) node.classList.remove('rz-edit-drop');
    };
    const onPointerDown = (event: Event) => {
      const pointer = event as PointerEvent;
      const target = pointer.target as Element | null;
      // 跨 realm 不能用 `instanceof Element`（帧文档里的 Element 与父页的不是同一个构造器），按 duck-typing 判。
      if (!target || typeof target.closest !== 'function') return;
      const node = target.closest('[data-rz-section]');
      const sectionId = node?.getAttribute('data-rz-section');
      const kind = node?.getAttribute('data-rz-kind') as ResumeSectionKindView | null;
      if (!node || !sectionId || !kind || pointer.button !== 0) return;
      // 纸上那一格是输入口：这一按**不接管**（不 preventDefault、不起拖拽），只把选中带过去。
      // 抢下这一按就等于把焦点从正在敲的那格移走，人只是想放个光标（spec 3.12-10）。
      if (target.closest('[data-rz-field]')) {
        liveRef.current.setSelectedId(sectionId);
        return;
      }
      pointer.preventDefault();
      const nodes = sectionNodes();
      const fromIndex = nodes.indexOf(node);
      const startY = pointer.clientY;
      let overIndex = fromIndex;
      /** 按指针纵坐标算落点：与左列清单共用 `dropIndexOfPointer`（帧内坐标不带缩放）。 */
      const indexOf = (clientY: number) =>
        dropIndexOfPointer(clientY, (index) => nodes[index]?.getBoundingClientRect(), nodes.length);
      const mark = () => {
        clearMarks();
        if (overIndex !== fromIndex) nodes[overIndex]?.classList.add('rz-edit-drop');
      };
      const onMove = (moveEvent: Event) => {
        const next = indexOf((moveEvent as PointerEvent).clientY);
        if (next === overIndex) return;
        overIndex = next;
        mark();
      };
      // 抬起那一下必须读**它自己**的坐标：按下的 `event` 与 `startY` 是同一次，拿它算位移永远是 0，
      // 于是"拖过也算点选"——换顺序这条通道会静默失效（写探针时才暴露，逻辑层看不出）。
      const onUp = (upEvent: Event) => {
        paperDoc.removeEventListener('pointermove', onMove);
        paperDoc.removeEventListener('pointerup', onUp);
        clearMarks();
        const moved = Math.abs((upEvent as PointerEvent).clientY - startY) >= DRAG_THRESHOLD_PX;
        if (!moved || overIndex === fromIndex) {
          liveRef.current.setSelectedId(sectionId);
          return;
        }
        liveRef.current.moveSection(sectionId, overIndex);
      };
      liveRef.current.setSelectedId(sectionId);
      paperDoc.addEventListener('pointermove', onMove);
      paperDoc.addEventListener('pointerup', onUp);
    };

    /** 焦点走进一格：记下这一格的写入坐标、原文与进编辑态之前的 HTML（3.12-09 的快照只在 Esc 那一条用）。 */
    const onFocusIn = (event: Event) => {
      const block = paperBlockOf((event as FocusEvent).target);
      if (!block) return;
      const key = blockKeyOf(block);
      if (heldRef.current?.key === key) return;
      // 走进来的这一格之前若还留着一格没交回（程序化移焦点走不了 focusout），先把它交回。
      flushHeld();
      heldRef.current = { ...block, key, snapshot: block.node.innerHTML, isCanceled: false, hasEdited: false };
      block.node.classList.add('rz-edit-focus');
      setEditingKey(key);
    };
    /** 帧内派上来的 `input` 只用来举旗：内容不进父页 state，纸上的 DOM 就是当下那一份（§2.5）。 */
    const onInput = () => {
      const held = heldRef.current;
      if (held) held.hasEdited = true;
    };
    /** 焦点走出这一格：交回（同格之内的移动不算离开，那一判据在 `flushHeld` 的 key 上）。 */
    const onFocusOut = (event: Event) => {
      const held = heldRef.current;
      if (!held) return;
      if ((event as FocusEvent).target !== held.node) return;
      flushHeld();
    };
    const onKeyDown = (event: Event) => {
      const key = event as KeyboardEvent;
      const held = heldRef.current;
      if (!held) return;
      if (key.key === 'Escape') {
        // Esc 只收这一格：逐字放回进编辑态之前的形状，一个字都不发（3.12-09）。
        key.preventDefault();
        held.isCanceled = true;
        held.node.innerHTML = held.snapshot;
        held.node.blur();
        flushHeld();
        return;
      }
      if ((key.metaKey || key.ctrlKey) && key.key.toLowerCase() === 'b') {
        // ⌘/Ctrl+B 就地加重（裁定㉘① 的更正）：`styleWithCSS=false` 逼出 `<b>` 而不是 `<span style=>`，
        // 反向文法只认 `<b>`/`<strong>` 这一档，于是落纸的标记一定能落回 `**…**`（3.12-07）。
        key.preventDefault();
        paperDoc.execCommand('styleWithCSS', false, 'false');
        paperDoc.execCommand('bold');
      }
    };
    /** 粘贴一律转成纯文本（3.12-08）：网页带来的 `style=`、`<span>`、`<font>` 都进不了打印面。 */
    const onPaste = (event: Event) => {
      const clip = event as ClipboardEvent;
      clip.preventDefault();
      const text = clip.clipboardData?.getData('text/plain') ?? '';
      paperDoc.execCommand('insertText', false, text);
    };

    paperDoc.addEventListener('pointerdown', onPointerDown, true);
    paperDoc.addEventListener('focusin', onFocusIn);
    paperDoc.addEventListener('focusout', onFocusOut);
    paperDoc.addEventListener('keydown', onKeyDown);
    paperDoc.addEventListener('paste', onPaste, true);
    paperDoc.addEventListener('input', onInput);
    return () => {
      paperDoc.removeEventListener('pointerdown', onPointerDown, true);
      paperDoc.removeEventListener('focusin', onFocusIn);
      paperDoc.removeEventListener('focusout', onFocusOut);
      paperDoc.removeEventListener('keydown', onKeyDown);
      paperDoc.removeEventListener('paste', onPaste, true);
      paperDoc.removeEventListener('input', onInput);
      style.remove();
    };
  }, [frame, paperNonce, flushHeld]);

  // 选中那一格换了（或纸重出）就把描边类重新落到对应节点上。
  useEffect(() => {
    const doc = frame?.contentDocument;
    if (!doc) return;
    for (const node of Array.from(doc.querySelectorAll('[data-rz-section]'))) {
      node.classList.toggle('rz-edit-selected', node.getAttribute('data-rz-section') === selectedId);
    }
  }, [frame, paperNonce, selectedId, paperHtml]);

  /**
   * 退出这一屏：与左列同一套判据（裁定⑪ 只拦组件卸载这一层），但**先算上还没落到投影的那一次打字**。
   * 交回打字与抬起手指点中退出键只隔一个往返，那一刻 `view.isDirty` 还是旧值；只看它就把刚敲的字连着会话丢了。
   */
  const requestClose = () => {
    if (view?.isDirty || hasTypedRef.current) setConfirmClose(true);
    else onClose();
  };

  // 那一次打字落到投影之后（干净态回来了，例如撤销到底或保存完成）就把这面旗收回，
  // 不然它会一直举着，"退出这一屏"从此每次都要问一遍。
  useEffect(() => {
    if (view?.isDirty === false) hasTypedRef.current = false;
  }, [view?.isDirty]);

  // Esc 有三层（spec 3.10-03 的顺序，加上 3.12-09 的最里层）：
  // 正在敲字 → 只收那一格（**帧内**那条 keydown 干的，这里只保证它不越界去收样式条）；
  // 选中还挂着 → 先收样式条；什么都没选 → 才是"退出这一屏"。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // 帧里的按键事件不会冒泡到父页文档，所以这一支只在"焦点在纸外、但那一格还举着"时兜底。
      if (editingKey !== undefined) {
        flushHeld();
        return;
      }
      if (selectedId !== undefined) setSelectedId(undefined);
      else requestClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedId, editingKey, flushHeld, view?.isDirty]);

  if (!view) {
    return (
      <div data-testid="resume-edit-page" className="fixed inset-0 z-40 flex items-center justify-center bg-ink-950">
        <p className="text-[11px] text-slate-400">{t('resume.editor.loading')}</p>
      </div>
    );
  }

  /** 一条数值轴（样式条里的字号与行距）：界表沿用投影那一张，越界由主进程拒并回一句话术。 */
  const numberRow = (
    axis: string,
    row: {
      boundKey: 'baseFontPt' | 'lineHeight';
      step: number;
      unit: 'pt' | 'ratio';
      current: number | undefined;
      fallback: number;
      onChange: (value: number) => void;
      onClear: () => void;
    },
  ) => {
    const bound = view.metricBounds[row.boundKey];
    const reach = (bound.max - bound.min) * OUT_OF_BOUNDS_REACH;
    const shown = row.current ?? row.fallback;
    return (
      <div key={axis} className="flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-slate-400">
        <span className="w-16 shrink-0">{t(`resume.editor.axes.${axis}`)}</span>
        <DeskRange
          action={`resume-edit-${axis}`}
          data-testid={`resume-edit-${axis}`}
          min={Number((bound.min - reach).toFixed(2))}
          max={Number((bound.max + reach).toFixed(2))}
          step={row.step}
          value={shown}
          {...dead(busyReason)}
          onValueChange={(value) => row.onChange(Number(value))}
          className="w-32"
        />
        <span data-testid={`resume-edit-value-${axis}`} className="w-14 text-slate-300">
          {shown} {t(`resume.editor.unit.${row.unit}`)}
        </span>
        <DeskButton
          action={`resume-edit-${axis}-follow`}
          variant="ghost"
          compact
          busy={!!busy}
          {...dead(afterBusy(row.current === undefined, 'ALREADY_FOLLOWING'))}
          onClick={row.onClear}
        >
          {t('resume.editor.followTemplate')}
        </DeskButton>
      </div>
    );
  };

  const paragraphStyle = selected ? view.layout.design?.paragraphs?.[selected.kind] : undefined;

  return (
    // 整屏 = 盖住主区（`fixed inset-0`），并且必须画在 `@container` 那一格**外面**：
    // `container-type: inline-size` 隐含 `contain: layout`，画在里面就只能盖住简历区（6.4-18 同一条实测）。
    <div data-testid="resume-edit-page" className="fixed inset-0 z-40 flex flex-col gap-2 bg-ink-950 p-3">
      <header className="flex min-w-0 flex-wrap items-center gap-2 border-b border-line pb-2">
        <DeskButton
          action="resume-edit-back"
          variant="line"
          compact
          busy={!!busy}
          {...dead(busyReason)}
          onClick={requestClose}
        >
          <X size={12} />
          {t('resume.edit.back')}
        </DeskButton>
        <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-slate-200">
          <Palette size={14} />
          {t('resume.edit.heading')}
        </h2>
        <p
          className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-slate-500"
          data-testid="resume-edit-who"
        >
          {docLabel ? t('resume.paper.who', { doc: docLabel, template: templateName ?? '-', locale }) : null}
        </p>
        {/* 脏态读数（`resume-edit-dirty`）搬进了右轨底部：3.13-05 的导出键与回执要求"动作、态、回执
            三点一线"（6.4-25 的③），头部那一格离导出键太远。锚点名一字不改，只换宿主的位置。 */}
        <DeskButton
          action="resume-edit-undo"
          variant="ghost"
          compact
          busy={!!busy}
          {...dead(undoReason)}
          onClick={() => stepHistory('undo')}
        >
          <Undo2 size={12} />
          {t('resume.editor.undo')}
        </DeskButton>
        <DeskButton
          action="resume-edit-redo"
          variant="ghost"
          compact
          busy={!!busy}
          {...dead(redoReason)}
          onClick={() => stepHistory('redo')}
        >
          <Redo2 size={12} />
          {t('resume.editor.redo')}
        </DeskButton>
        <DeskButton
          action="resume-edit-save"
          variant="amber"
          compact
          busy={!!busy}
          {...dead(saveReason)}
          onClick={() => {
            void save();
          }}
        >
          <Save size={12} />
          {t('resume.editor.save')}
        </DeskButton>
      </header>

      {confirmClose && (
        <Banner tone="amber" markers={{ testid: 'resume-edit-close-confirm' }}>
          <div className="w-full">
            <p className="text-xs font-semibold">{t('resume.editor.closeConfirmTitle')}</p>
            <p className="mt-1 text-xs opacity-80">{t('resume.editor.closeConfirmHint')}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <DeskButton
                action="resume-edit-close-save"
                variant="amber"
                compact
                busy={!!busy}
                {...dead(busyReason)}
                onClick={() => {
                  void save().then(() => onClose());
                }}
              >
                {t('resume.editor.saveAndLeave')}
              </DeskButton>
              <DeskButton action="resume-edit-close-discard" variant="seal" compact onClick={() => onClose()}>
                {t('resume.editor.discardAndLeave')}
              </DeskButton>
              <DeskButton
                action="resume-edit-close-stay"
                variant="ghost"
                compact
                onClick={() => setConfirmClose(false)}
              >
                {t('resume.editor.keepEditing')}
              </DeskButton>
            </div>
          </div>
        </Banner>
      )}

      {rejected && (
        <Banner tone="seal" markers={{ testid: 'resume-edit-rejected' }} className="break-all">
          {t('resume.editor.rejected', { message: rejected })}
        </Banner>
      )}
      {notice && (
        <Banner tone={noticeTone} markers={{ testid: 'resume-edit-notice' }} className="break-all">
          {notice}
        </Banner>
      )}

      <p className="text-[11px] leading-relaxed text-slate-400" data-testid="resume-edit-hint">
        {t('resume.edit.hint')}
      </p>

      <div className="flex min-h-0 min-w-0 flex-1 gap-3">
        {/* 左轨管"内容"（区块清单 / 条目拆并 = 那份纯表现层的 `ResumeEditor`，吃这一屏的 session）。
            可收起，且收起走**条件挂载**：收起态下这一整格不在 DOM 里（不是 `display:none`——零宽高的同名
            选择器会命中看不见的那一份，§9 的 5.4-b ⑦ / 6.4-25 的 C），只剩下面那一条 24px 的把手。 */}
        {contentRailOpen ? (
          <aside data-testid="resume-edit-rail-content" className="flex w-80 shrink-0 flex-col gap-2 overflow-auto">
            <div className="flex justify-end">
              <DeskButton
                action="resume-edit-rail-collapse"
                variant="ghost"
                compact
                aria-label={t('resume.edit.rail.collapse')}
                markers={{ testid: 'resume-edit-rail-collapse' }}
                onClick={() => setContentRailOpen(false)}
              >
                <PanelLeftClose size={12} />
              </DeskButton>
            </div>
            <ResumeEditor session={session} />
          </aside>
        ) : (
          // 收起态常驻的那一条把手（24px 宽，06 plan §3.35 决定 1）：点开它内容轨才回来。
          <div className="flex w-6 shrink-0 flex-col">
            <DeskButton
              action="resume-edit-rail-expand"
              variant="ghost"
              compact
              aria-label={t('resume.edit.rail.expand')}
              markers={{ testid: 'resume-edit-rail-expand' }}
              className="w-6"
              onClick={() => setContentRailOpen(true)}
            >
              <PanelLeftOpen size={12} />
            </DeskButton>
          </div>
        )}

        {/* 纸：整屏的正中央、唯一的主角（06 plan §3.35）。左右两条轨各占各的宽，剩下的都给它；
            这一屏**只按宽判**（`fit="width"`，spec 6.4-24 的两档）：人是趴在纸上打字的，按一页的高缩就把纸压成卡片了。 */}
        <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-auto">
          <ResumePaperFrame
            html={paperHtml}
            frameTestId="resume-edit-paper"
            frameTitle={t('resume.edit.heading')}
            sandbox="allow-same-origin"
            emptyTestId="resume-edit-paper-empty"
            emptyLabel={t('resume.editor.previewEmpty')}
            slotTestId="resume-edit-slot"
            fit="width"
            slotClassName="min-w-0 overflow-hidden p-3"
            onFrameLoad={onPaperLoad}
          />
        </div>

        {/* 右轨管"呈现与出货"（常开，06 plan §3.35）：样式网格 → 整份文档的度量 → 出货段（脏态、导出键、回执）。
            浮出的样式条管的是"这一段这一类"，这一轨管"整份简历长什么样、什么时候出纸"——两件事，不再被"样式"一个词捆着。 */}
        <aside
          data-testid="resume-edit-rail-output"
          className="flex w-72 shrink-0 flex-col gap-3 overflow-auto rounded-sheet border border-line bg-ink-900/60 p-3"
        >
          <h3 className="flex items-center gap-1 text-[11px] font-semibold text-slate-300">
            <Palette size={12} />
            {t('resume.edit.template.railTitle')}
          </h3>

          {/* 样式网格（从 desk 搬进来，3.13-04）：点一套 = `onTemplateChange` 回写 desk 那一份 templateId，
              `useResumeEditor` 的对齐效应随即补一次 `editor.use` 换预览；"设为默认"落 `export.setPreference`。
              整条路只有这一处入口，desk 上只剩读数（3.13-07）。 */}
          <TemplateShelf
            templates={templates}
            selectedId={templateId}
            defaultId={defaultTemplateId}
            filter={shelfFilter}
            onFilterChange={setShelfFilter}
            onSelect={onTemplateChange}
            onSetDefault={rememberTemplate}
            busy={!!busy || !!shipBusy}
            disabledReason={shelfPendingReason}
            disabledReasonLabel={
              shelfPendingReason === undefined ? undefined : t(`resume.reason.${shelfPendingReason}`)
            }
          />

          {/* 文档级的度量：这一段只管"整份文档"的那六格 + 字族，段级的在纸上那一条样式里。 */}
          <div className="flex flex-col gap-2 border-t border-line pt-2">
            <h3 className="flex items-center gap-1 text-[11px] font-semibold text-slate-300">
              <SlidersHorizontal size={12} />
              {t('resume.edit.globals')}
            </h3>
            {METRIC_ROWS.map((row) => {
              const bound = view.metricBounds[row.key];
              const reach = (bound.max - bound.min) * OUT_OF_BOUNDS_REACH;
              const current =
                row.key === 'baseFontPt'
                  ? view.layout.baseFontPt
                  : row.key === 'lineHeight'
                    ? view.layout.lineHeight
                    : view.layout.margin[row.key];
              return (
                <div key={row.key} className="flex flex-col gap-1 text-[11px] text-slate-400">
                  <span data-testid={`resume-edit-metric-label-${row.key}`}>{t(`resume.editor.units.${row.key}`)}</span>
                  <DeskRange
                    action={`resume-edit-metric-${row.key}`}
                    data-testid={`resume-edit-metric-${row.key}`}
                    min={Number((bound.min - reach).toFixed(2))}
                    max={Number((bound.max + reach).toFixed(2))}
                    step={row.step}
                    value={current}
                    {...dead(busyReason)}
                    onValueChange={(value) => setMetric(row.key, Number(value))}
                  />
                  <span data-testid={`resume-edit-metric-value-${row.key}`} className="text-slate-300">
                    {current} {t(`resume.editor.unit.${row.unit}`)}
                  </span>
                </div>
              );
            })}
            {/* 字族是整份文档那一格（`design.body.fontFamily`），与纸面上那五格不同层，所以摆在右轨。 */}
            <div className="flex flex-col gap-1 text-[11px] text-slate-400">
              <span data-testid="resume-edit-family-label">{t('resume.editor.axes.bodyFontFamily')}</span>
              <DeskSegmented
                action="resume-edit-body-family"
                markers={{ testid: 'resume-edit-body-family' }}
                value={view.layout.design?.body?.fontFamily ?? INHERIT}
                options={[
                  { value: INHERIT, label: t('resume.editor.followTemplate') },
                  ...FONT_FAMILY_TOKENS.map((token) => ({ value: token, label: t(`resume.editor.family.${token}`) })),
                ]}
                onSelect={(value) =>
                  applyDesign('bodyFontFamily', { body: { fontFamily: value === INHERIT ? null : value } })
                }
                busy={!!busy}
                disabledReason={busyReason}
                disabledReasonLabel={reasonLabel(busyReason)}
              />
            </div>
          </div>

          {/* 出货段：导出键、脏态读数、回执**三点一线**（3.13-05 / 6.4-25 的③，纵向排好，不让人去别的界面找回执）。
              导出这颗走"先落库再出纸"，脏的时候**不 disable**（3.13-05 的反例之一），只在有动作在途时按不动。 */}
          <div className="flex flex-col gap-2 border-t border-line pt-2">
            <span
              data-testid="resume-edit-dirty"
              data-dirty={String(view.isDirty)}
              className={
                view.isDirty
                  ? 'self-start rounded-chip border border-amber/45 px-1 text-[11px] text-amber'
                  : 'self-start rounded-chip border border-line px-1 text-[11px] text-slate-400'
              }
            >
              {t(view.isDirty ? 'resume.editor.dirty' : 'resume.editor.clean')}
            </span>
            <DeskButton
              action="export"
              variant="amber"
              compact
              busy={!!busy || !!shipBusy}
              {...dead(shipBusyReason)}
              className="self-start"
              onClick={exportPdf}
            >
              <FileDown size={12} />
              {t('resume.export')}
            </DeskButton>
            {shipNotice && (
              <Banner tone={shipNoticeTone} markers={{ testid: 'resume-edit-export-notice' }} className="break-all">
                {shipNotice}
              </Banner>
            )}
            {/* 导出回执条：锚点名（`resume-receipt-path` / `resume-receipt-metrics` / `resume-reveal-pdf`）
                一字不改地从 desk 的纸面槽搬进这一轨（3.13-06"只换宿主"）。没导过时整条不画，而不是摆一个 0 页。 */}
            {exportReceipt && (
              <div className="flex min-w-0 flex-col gap-1" data-testid="resume-edit-receipt">
                <p
                  className="break-all font-mono text-[11px] text-slate-500"
                  data-testid="resume-receipt-path"
                  title={exportReceipt.path}
                >
                  {exportReceipt.path}
                </p>
                <p className="font-mono text-[11px] text-slate-400" data-testid="resume-receipt-metrics">
                  {t('resume.paper.receipt', { pages: exportReceipt.pages, bytes: exportReceipt.bytes })}
                </p>
                <DeskButton
                  action="resume-reveal-pdf"
                  variant="line"
                  compact
                  className="self-start"
                  onClick={revealReceipt}
                >
                  {revealLabel}
                </DeskButton>
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* 样式条：钉在选中那一段的上方（放不下就下方），位置只写在 `--rz-bar-x/y` 这两个变量上。
          它只摆**真能改**的那几格：段落六轴里这里给字号 / 行距 / 对齐 / 字重 / 字色，加上一对换顺序的键。
          正文不在这里摆格子——纸上那一格就是正文的口（裁定㉚），而人正在敲的那一格上不能盖描边（3.12-10）。 */}
      {selected && editingKey === undefined && (
        <div
          ref={barRef}
          data-testid="resume-edit-bar"
          data-kind={selected.kind}
          data-section-id={selected.id}
          className="absolute left-(--rz-bar-x) top-(--rz-bar-y) z-10 flex w-[560px] max-w-[calc(100vw-16px)] flex-col gap-1.5 rounded-sheet border border-line-strong bg-ink-900 p-3 shadow-sheet"
        >
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-[11px] font-semibold text-slate-200">
              {t('resume.edit.selected', { kind: t(`resume.kind.${selected.kind}`) })}
            </p>
            <p className="min-w-0 flex-1 truncate text-[11px] text-slate-500">{t('resume.edit.byKind')}</p>
            <DeskButton
              action="resume-edit-move-up"
              variant="ghost"
              compact
              busy={!!busy}
              {...dead(moveUpReason)}
              onClick={() => moveSection(selected.id, selectedIndex - 1)}
            >
              <ChevronUp size={12} />
              {t('resume.edit.moveUp')}
            </DeskButton>
            <DeskButton
              action="resume-edit-move-down"
              variant="ghost"
              compact
              busy={!!busy}
              {...dead(moveDownReason)}
              onClick={() => moveSection(selected.id, selectedIndex + 1)}
            >
              <ChevronDown size={12} />
              {t('resume.edit.moveDown')}
            </DeskButton>
            <DeskButton
              action="resume-edit-bar-close"
              variant="ghost"
              compact
              aria-label={t('resume.edit.close')}
              onClick={() => setSelectedId(undefined)}
            >
              <X size={12} />
            </DeskButton>
          </div>

          {numberRow('paragraphSizePt', {
            boundKey: 'baseFontPt',
            step: 0.5,
            unit: 'pt',
            current: paragraphStyle?.sizePt,
            fallback: view.layout.design?.body?.sizePt ?? view.layout.baseFontPt,
            onChange: (value) => applyDesign('paragraphSizePt', paragraphPatch(selected.kind, 'sizePt', value)),
            onClear: () => applyDesign('paragraphSizePt', paragraphPatch(selected.kind, 'sizePt', null)),
          })}
          {numberRow('paragraphLineHeight', {
            boundKey: 'lineHeight',
            step: 0.05,
            unit: 'ratio',
            current: paragraphStyle?.lineHeight,
            fallback: view.layout.lineHeight,
            onChange: (value) => applyDesign('paragraphLineHeight', paragraphPatch(selected.kind, 'lineHeight', value)),
            onClear: () => applyDesign('paragraphLineHeight', paragraphPatch(selected.kind, 'lineHeight', null)),
          })}

          <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-slate-400">
            <span className="w-16 shrink-0">{t('resume.editor.axes.paragraphAlign')}</span>
            <DeskSegmented
              action="resume-edit-paragraph-align"
              markers={{ testid: 'resume-edit-paragraph-align' }}
              value={paragraphStyle?.align ?? INHERIT}
              options={[
                { value: INHERIT, label: t('resume.editor.followTemplate') },
                ...TEXT_ALIGN_TOKENS.map((token) => ({ value: token, label: t(`resume.editor.align.${token}`) })),
              ]}
              onSelect={(value) => applyDesign('paragraphAlign', paragraphPatch(selected.kind, 'align', value))}
              busy={!!busy}
              disabledReason={busyReason}
              disabledReasonLabel={reasonLabel(busyReason)}
            />
            <span className="w-16 shrink-0">{t('resume.editor.axes.paragraphWeight')}</span>
            <DeskSegmented
              action="resume-edit-paragraph-weight"
              markers={{ testid: 'resume-edit-paragraph-weight' }}
              value={paragraphStyle?.weight ?? INHERIT}
              options={[
                { value: INHERIT, label: t('resume.editor.followTemplate') },
                ...FONT_WEIGHT_TOKENS.map((token) => ({ value: token, label: t(`resume.editor.weight.${token}`) })),
              ]}
              onSelect={(value) => applyDesign('paragraphWeight', paragraphPatch(selected.kind, 'weight', value))}
              busy={!!busy}
              disabledReason={busyReason}
              disabledReasonLabel={reasonLabel(busyReason)}
            />
          </div>

          <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-slate-400">
            <span className="w-16 shrink-0">{t('resume.editor.axes.paragraphInkHex')}</span>
            <DeskSwatch
              action="resume-edit-paragraph-ink"
              markers={{ testid: 'resume-edit-paragraph-ink' }}
              hexes={SWATCH_HEXES}
              value={paragraphStyle?.inkHex}
              clearLabel={t('resume.editor.followTemplate')}
              nameOf={(hex) => t('resume.editor.swatchName', { hex })}
              onSelect={(hex) => applyDesign('paragraphInkHex', paragraphPatch(selected.kind, 'inkHex', hex))}
              onClear={() => applyDesign('paragraphInkHex', paragraphPatch(selected.kind, 'inkHex', null))}
              busy={!!busy}
              disabledReason={busyReason}
              disabledReasonLabel={reasonLabel(busyReason)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
