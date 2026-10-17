/**
 * 编辑器的标题栏与 Ribbon（仿 WPS 标签行）——编辑器屏的**顶部五金件**。
 *
 * 渲染层 6.2-14：面板不写裸控件，所有按钮只出自 `ui/controls.tsx` 的 `DeskButton`
 * （悬停/按不动/原因码/凭据 data-action 都由原件持有，这里只给动作与档位）。
 *
 * E2 三个标签：
 * - 开始：选择/编辑文字、文本框、撤销/重做、另存；
 * - 插入：文本框（图片/形状等 P1 工具在 E3 落这同一行）；
 * - 视图：放大/缩小/适应宽度/100%、缩略图栏与属性卡开关。
 * 标签状态是纯本屏 UI（不进会话），留在组件本地。
 */
import {
  ArrowLeft,
  Maximize2,
  MousePointer2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Redo2,
  Save,
  Type,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DeskButton } from '../ui/controls';
import type { PdfEditorModel } from './usePdfEditor';
import { zoomPercent } from './editor-tools';

type RibbonTab = 'home' | 'insert' | 'view';

const TABS: readonly { id: RibbonTab; labelKey: string; action: string }[] = [
  { id: 'home', labelKey: 'pdfEditor.tabHome', action: 'pdf-editor-tab-home' },
  { id: 'insert', labelKey: 'pdfEditor.tabInsert', action: 'pdf-editor-tab-insert' },
  { id: 'view', labelKey: 'pdfEditor.tabView', action: 'pdf-editor-tab-view' },
];

export function EditorRibbon({ model }: { model: PdfEditorModel }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<RibbonTab>('home');

  return (
    <div data-testid="pdf-editor-ribbon" className="border-b border-line-strong bg-ink-950/80">
      {/* 标签行 */}
      <div className="flex items-center gap-1 px-2 pt-1">
        {TABS.map((item) => (
          <DeskButton
            key={item.id}
            action={item.action}
            variant="ghost"
            compact
            markers={{ on: tab === item.id ? 'true' : 'false' }}
            className={tab === item.id ? 'rounded-b-none bg-ink-900 text-slate-100' : 'rounded-b-none text-slate-400'}
            onClick={() => setTab(item.id)}
          >
            {t(item.labelKey)}
          </DeskButton>
        ))}
      </div>

      {/* 工具行 */}
      <div className="flex min-h-[68px] items-center gap-2 bg-ink-900/90 px-3 py-1.5">
        {tab === 'home' && (
          <>
            <DeskButton
              action="pdf-editor-tool-pointer"
              variant={model.tool === 'pointer' ? 'solid' : 'ghost'}
              markers={{ testid: 'pdf-editor-tool-pointer', on: model.tool === 'pointer' ? 'true' : 'false' }}
              title={t('pdfEditor.toolPointerTitle')}
              className="h-14 w-[72px] flex-col gap-1"
              onClick={() => model.setTool('pointer')}
            >
              <MousePointer2 size={16} />
              {t('pdfEditor.toolPointer')}
            </DeskButton>
            <DeskButton
              action="pdf-editor-tool-text"
              variant={model.tool === 'text' ? 'solid' : 'ghost'}
              markers={{ testid: 'pdf-editor-tool-text', on: model.tool === 'text' ? 'true' : 'false' }}
              title={t('pdfEditor.toolTextTitle')}
              className="h-14 w-[72px] flex-col gap-1"
              onClick={() => model.setTool('text')}
            >
              <Type size={16} />
              {t('pdfEditor.toolText')}
            </DeskButton>
            <span className="mx-1 h-9 w-px bg-line-strong" />
            <DeskButton
              action="pdf-editor-undo"
              variant="line"
              compact
              disabled={!model.canUndo}
              disabledReason={model.canUndo ? undefined : 'AT_HISTORY_START'}
              disabledReasonLabel={model.canUndo ? undefined : t('pdfEditor.undoDisabled')}
              onClick={() => model.undo()}
            >
              <Undo2 size={13} />
              {t('pdfEditor.undo')}
            </DeskButton>
            <DeskButton
              action="pdf-editor-redo"
              variant="line"
              compact
              disabled={!model.canRedo}
              disabledReason={model.canRedo ? undefined : 'AT_HISTORY_END'}
              disabledReasonLabel={model.canRedo ? undefined : t('pdfEditor.redoDisabled')}
              onClick={() => model.redo()}
            >
              <Redo2 size={13} />
              {t('pdfEditor.redo')}
            </DeskButton>
            <span className="mx-1 h-9 w-px bg-line-strong" />
            <DeskButton
              action="pdf-editor-save"
              variant="jade"
              compact
              busy={model.saving}
              markers={{ testid: 'pdf-editor-save' }}
              onClick={() => void model.saveAs()}
            >
              <Save size={13} />
              {model.saving ? t('pdfEditor.saving') : t('pdfEditor.saveAs')}
            </DeskButton>
          </>
        )}

        {tab === 'insert' && (
          <>
            <DeskButton
              action="pdf-editor-insert-text"
              variant={model.tool === 'text' ? 'solid' : 'ghost'}
              title={t('pdfEditor.toolTextTitle')}
              className="h-14 w-[72px] flex-col gap-1"
              onClick={() => model.setTool('text')}
            >
              <Type size={16} />
              {t('pdfEditor.toolText')}
            </DeskButton>
            <p className="ml-2 max-w-[360px] text-[11px] leading-relaxed text-slate-500">{t('pdfEditor.insertHint')}</p>
          </>
        )}

        {tab === 'view' && (
          <>
            <DeskButton action="pdf-editor-zoom-out" variant="line" compact onClick={() => model.zoomOut()}>
              <ZoomOut size={13} />
              {t('pdfEditor.zoomOut')}
            </DeskButton>
            <span className="min-w-[52px] text-center text-[11px] tabular-nums text-slate-300">
              {zoomPercent(model.pageWidthPx)}%
            </span>
            <DeskButton action="pdf-editor-zoom-in" variant="line" compact onClick={() => model.zoomIn()}>
              <ZoomIn size={13} />
              {t('pdfEditor.zoomIn')}
            </DeskButton>
            <DeskButton
              action="pdf-editor-fit-width"
              variant="line"
              compact
              title={t('pdfEditor.fitWidthTitle')}
              onClick={() => model.fitWidth(viewFitWidth())}
            >
              <Maximize2 size={13} />
              {t('pdfEditor.fitWidth')}
            </DeskButton>
            <DeskButton action="pdf-editor-zoom-actual" variant="line" compact onClick={() => model.zoomActual()}>
              100%
            </DeskButton>
            <span className="mx-1 h-9 w-px bg-line-strong" />
            <DeskButton
              action="pdf-editor-toggle-thumbs"
              variant="line"
              compact
              onClick={() => model.setThumbsOpen(!model.thumbsOpen)}
            >
              {model.thumbsOpen ? <PanelLeftClose size={13} /> : <PanelLeftOpen size={13} />}
              {t('pdfEditor.pages')}
            </DeskButton>
            <DeskButton
              action="pdf-editor-toggle-props"
              variant="line"
              compact
              onClick={() => model.setPropsOpen(!model.propsOpen)}
            >
              {model.propsOpen ? <PanelRightClose size={13} /> : <PanelRightOpen size={13} />}
              {t('pdfEditor.props')}
            </DeskButton>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * 适应宽度需要中央滚动容器的宽度；Ribbon 不持有那个 ref，这里按选择器量一次
 * （屏组件给容器挂了稳定 testid，量宽度不依赖组件树传参）。
 */
function viewFitWidth(): number {
  const node = document.querySelector('[data-testid="pdf-editor-scroll"]');
  return node instanceof HTMLElement ? node.clientWidth : 0;
}

/** 标题栏（返回 / 文件名 / 脏点）；单独导出供屏组件摆在 Ribbon 之上。 */
export function EditorHeader({ model }: { model: PdfEditorModel }) {
  const { t } = useTranslation();
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-ink-950 px-3">
      <DeskButton
        action="pdf-editor-back"
        variant="line"
        compact
        markers={{ testid: 'pdf-editor-back' }}
        onClick={() => model.requestClose()}
      >
        <ArrowLeft size={13} />
        {t('pdfEditor.back')}
      </DeskButton>
      <span className="ml-1 truncate text-[13px] font-medium text-slate-200" title={model.filePath}>
        {model.fileName}
      </span>
      {model.dirty && (
        <span
          className="inline-block h-2 w-2 rounded-full bg-amber-400"
          title={t('pdfEditor.dirtyTitle')}
          aria-label={t('pdfEditor.dirtyTitle')}
        />
      )}
      {model.savedTo && (
        <span className="truncate text-[11px] text-slate-500" title={model.savedTo}>
          {t('pdfEditor.savedBadge', { path: model.savedTo })}
        </span>
      )}
    </header>
  );
}
