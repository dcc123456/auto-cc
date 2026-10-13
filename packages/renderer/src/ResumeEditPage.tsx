import { ChevronDown, ChevronUp, Palette, Redo2, Save, SlidersHorizontal, Undo2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ResumeLocaleView, ResumeSectionKindView } from '@auto-cc/shared';
import { ResumePaperFrame } from './ResumePaperFrame';
import { Banner, DeskButton, DeskRange, DeskSegmented, DeskSwatch, deskReason } from './ui/controls';
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

/** 样式条的名义宽度（clamp 落点时用来自证右缘不越窗）。 */
const STYLE_BAR_WIDTH_PX = 560;

/** 样式条与那一段之间留的缝隙（px），以及贴在窗顶之下多少才算"放得下"。 */
const STYLE_BAR_GAP_PX = 10;
const STYLE_BAR_TOP_FLOOR_PX = 96;

/**
 * 注进纸面帧里的那一小段样式（选中的那一格 + 拖拽落点那一格）。
 *
 * 为什么在帧内注一条规则而不是在父页盖一层描边：纸是被 `scale` 缩放过的，父页那一层要跟着每帧重算矩形，
 * 而段落在**帧内**的矩形天然就是排版后的真实位置。这一条只描边、不改排版（`outline` 不占布局盒），
 * 所以它进不了导出产物——导出走的是主进程那份 HTML，与界面里这一个运行期节点无关（spec 3.10-02 的读数）。
 */
const PAPER_EDIT_STYLE = [
  '[data-rz-section]{cursor:pointer}',
  '[data-rz-section].rz-edit-selected{outline:2px solid #a31621;outline-offset:3px}',
  '[data-rz-section].rz-edit-drop{outline:2px dashed #0b5c50;outline-offset:-2px}',
].join('');

/** 指针按下到抬起之间，算"拖过"的位移门槛（px）：低于它按**点选**处理，不发任何跨进程调用。 */
const DRAG_THRESHOLD_PX = 4;

/**
 * 整页直接编辑（spec 3.10 / 裁定㉙）。
 *
 * **这一屏只解决"对着纸改排版"**：点一段 → 那一段的字号 / 行距 / 对齐 / 字重 / 字色 + 上移下移，
 * 文档级的基准字号 / 行距 / 四边距在右边那一窄栏。正文文字**不在这里改**（裁定㉙ 第 1 条：
 * 那一半需要一条带正文的桥接口，另立一片 3.11），所以这一屏上不画任何"点了没反应"的假控件（§2.6）。
 *
 * 三条形状约束：
 * ① **画面仍出自同一个 builder**——纸上是 `resume.editor.preview` 返回的那份 draft HTML，
 *    与导出产物同一份源（3.3-01 在这屏继续成立），这里没有第二套简历渲染器（§2.5）；
 * ② **命中在父页一侧做**——帧是 `sandbox="allow-same-origin"`（不放开 `allow-scripts`），
 *    帧内不跑脚本，父页读它的 DOM 量矩形、给它挂监听（plan §15 的实测表就是按这一条选的路线）；
 * ③ **会话只有一份**——所有动作走 `useResumeEditor`，与左列编排面板同一条撤销栈（spec 3.10-07）。
 * @param docId 要编辑的那份文档（由 desk 持有）
 * @param templateId 架上选中的版式（同上，唯一来源）
 * @param locale 架上选中的预览语言
 * @param docLabel 身份读数（姓名读不到就露 id）
 * @param templateName 版式展示名
 * @param onClose 退出这一屏（dirty 时先走屏内的确认）
 */
export function ResumeEditPage({
  docId,
  templateId,
  locale,
  docLabel,
  templateName,
  onClose,
}: {
  docId: string;
  templateId: string;
  locale: ResumeLocaleView;
  docLabel?: string;
  templateName?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
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
  /** 样式条的落点（视口坐标，px）：写成 CSS 变量而不是 `style={}`（§5.1，与 `--paper-scale` 同一口径）。 */
  const barRef = useRef<HTMLDivElement | null>(null);
  /** 纸所在的那一格是这一屏的滚动容器：滚动要把样式条跟着挪或收起。 */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);

  const { view, rejected, busy, notice, noticeTone, setMetric, applyDesign, moveSection, stepHistory, save } =
    useResumeEditor({ docId, templateId, locale, onPreview: setPaperHtml });

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

  /**
   * 动作与状态的**当下引用**：拖拽过程跨好几拍，抬起那一刻要读最新的 `moveSection` 与 setter，
   * 而监听挂的是帧内文档（重挂一次就把整趟拖拽打断），所以经这一只 ref 现问而不是把监听重挂一遍。
   */
  const liveRef = useRef({ moveSection, setSelectedId });
  useEffect(() => {
    liveRef.current = { moveSection, setSelectedId };
  });

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
    const paperRect = paper.getBoundingClientRect();
    const naturalWidth = paper.offsetWidth;
    if (naturalWidth < 1) return;
    const scale = paperRect.width / naturalWidth;
    const hit = node.getBoundingClientRect();
    const top = paperRect.top + hit.top * scale;
    const height = hit.height * scale;
    const below = top < STYLE_BAR_TOP_FLOOR_PX;
    const left = Math.min(
      Math.max(8, paperRect.left + hit.left * scale),
      Math.max(8, window.innerWidth - STYLE_BAR_WIDTH_PX - 8),
    );
    bar.style.setProperty('--rz-bar-x', `${Math.round(left)}px`);
    bar.style.setProperty(
      '--rz-bar-y',
      `${Math.round(below ? top + height + STYLE_BAR_GAP_PX : top - STYLE_BAR_GAP_PX)}px`,
    );
  }, [frame, paperNonce, selectedId]);

  // 选中变了、纸换了、窗口动了、格子滚了——样式条都要跟着重钉一次。
  useEffect(() => {
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
   * 纸面帧装载好之后：注一条选中样式、把命中测试挂在**帧内文档**上。
   *
   * 监听挂在 `pointerdown` 当场（与左列拖拽同一条活体教训：`harness drag` 的 up 在 effect 跑之前就过去了）。
   * 一次按下只做两件事之一：位移超过门槛就是**换顺序**（抬起时发一次 `resume.editor.move`，落点没变就一个字节都不发），
   * 没超过就是**选中**（长出样式条）。整个拖拽过程只改帧内那个节点的 class，不触发父页重渲。
   */
  useEffect(() => {
    const paperDoc = frame?.contentDocument;
    if (!paperDoc) return;
    const style = paperDoc.createElement('style');
    style.textContent = PAPER_EDIT_STYLE;
    paperDoc.head.appendChild(style);
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
    paperDoc.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      paperDoc.removeEventListener('pointerdown', onPointerDown, true);
      style.remove();
    };
  }, [frame, paperNonce]);

  // 选中那一格换了（或纸重出）就把描边类重新落到对应节点上。
  useEffect(() => {
    const doc = frame?.contentDocument;
    if (!doc) return;
    for (const node of Array.from(doc.querySelectorAll('[data-rz-section]'))) {
      node.classList.toggle('rz-edit-selected', node.getAttribute('data-rz-section') === selectedId);
    }
  }, [frame, paperNonce, selectedId, paperHtml]);

  /** 退出这一屏：与左列同一套判据（裁定⑪ 只拦组件卸载这一层）。 */
  const requestClose = () => {
    if (view?.isDirty) setConfirmClose(true);
    else onClose();
  };

  // Esc 有两层（spec 3.10-03：条要先收，纸才谈得上退出）：
  // 选中还挂着 → 先收样式条；什么都没选 → 才是"退出这一屏"，并且要先过上面那道未保存的拦截。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (selectedId !== undefined) setSelectedId(undefined);
      else requestClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedId, view?.isDirty]);

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
        <span
          data-testid="resume-edit-dirty"
          data-dirty={String(view.isDirty)}
          className={
            view.isDirty
              ? 'rounded-chip border border-amber/45 px-1 text-[11px] text-amber'
              : 'rounded-chip border border-line px-1 text-[11px] text-slate-400'
          }
        >
          {t(view.isDirty ? 'resume.editor.dirty' : 'resume.editor.clean')}
        </span>
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
        {/* 纸：整屏的宽度都给它（左列那 400px 与把手那 6px 都不在这屏存在），所以同一份界表算出来的
            倍率在这一屏是 1（A4 原尺寸），而右栏那一档最多到 0.7 上下——这就是用户报的"区域太小"的差值。 */}
        <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-auto">
          <ResumePaperFrame
            html={paperHtml}
            frameTestId="resume-edit-paper"
            frameTitle={t('resume.edit.heading')}
            sandbox="allow-same-origin"
            emptyTestId="resume-edit-paper-empty"
            emptyLabel={t('resume.editor.previewEmpty')}
            slotTestId="resume-edit-slot"
            slotClassName="min-h-full min-w-0 overflow-hidden p-3"
            onFrameLoad={onPaperLoad}
          />
        </div>

        {/* 文档级的度量：这一窄栏只管"整份文档"的那六格，段级的在纸上那一条样式里。 */}
        <aside className="flex w-56 shrink-0 flex-col gap-2 overflow-auto rounded-sheet border border-line bg-ink-900/60 p-3">
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
          {/* 字族是整份文档那一格（`design.body.fontFamily`），与纸面上那五格不同层，所以摆在右栏。 */}
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
        </aside>
      </div>

      {/* 样式条：钉在选中那一段的上方（放不下就下方），位置只写在 `--rz-bar-x/y` 这两个变量上。
          它只摆**真能改**的那几格：段落六轴里这里给字号 / 行距 / 对齐 / 字重 / 字色，加上一对换顺序的键；
          正文输入一格都不摆（裁定㉙：那要一条带正文的桥接口，另立一片）。 */}
      {selected && (
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
