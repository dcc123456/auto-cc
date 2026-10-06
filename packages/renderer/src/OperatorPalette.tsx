/**
 * 算子库调色板（spec 5.10-03 的第一处派生读者 + 06 子计划 6.5-01 的效果色分区）。
 *
 * 列表、分区、图标、危险度徽标**全部**来自 `WORKFLOW_OPERATORS`：这里不出现任何一只算子的名字，
 * 也不出现「哪只算子能放在这一栏」的本地判断。加一只算子的唯一动作是往描述表里加一行（U 用例
 * `operators.test.ts` 就是照这条判据写的）。
 *
 * 分区依据是**副作用档**（06 稿的三色归属：读=jade / 本机写=amber / 外发=seal），因为用户在这一栏
 * 要回答的第一问是「这一步会不会离开这台机器」；分类退到分区内的一行行标签，两层都仍由描述表派生。
 *
 * 6.5-04 起这一栏既能**点**也能**拖**：点一格仍是 5.10-03 那条建格通路（一字未改），
 * 拖则是按下之后由画布接管鼠标——调色板只交出"从哪一格起手"，并在被拖走那一格的原槽位上留残影。
 */
import { useTranslation } from 'react-i18next';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { groupOperatorsByCategory, groupOperatorsByEffect, type OperatorDescriptor } from '@auto-cc/shared';
import { DeskButton, EffectChip, EFFECT_BUTTON_VARIANT, EFFECT_TONE_CLASS, deskReason } from './ui/controls';
import { operatorIconOf } from './operator-icons';

/** 被拖走那一格的原槽位（10 稿⑤）：留 40% 残影，并换一圈朱砂虚线描边。 */
const DRAG_ORIGIN_CLASS = 'opacity-40 outline-2 outline-dashed outline-offset-2 outline-seal';

export interface OperatorPaletteProps {
  /** 点中一格就把整份描述交给画布建节点：id/危险度/出口/参数初值都由画布按描述表算。 */
  onAdd: (descriptor: OperatorDescriptor) => void;
  /**
   * 起手（spec 6.5-04：拖进画布）：调色板只报"从哪一格、在哪按下"，
   * 落点要经画布那一份 `screenToFlowPosition` 换算、命令栈与视图层落点也都在画布那边——
   * 这里再算一套落点就是第二份事实（§2.5）。
   */
  onDragStart?: (descriptor: OperatorDescriptor, event: ReactMouseEvent<HTMLButtonElement>) => void;
  /** 此刻正被拖走的那一格的 kind；undefined = 没有在拖 */
  draggingKind?: string;
  /** 只读（spec 5.10-11：正在跑的时候不许改图）——按钮禁用并在段末写清原因 */
  isReadOnly: boolean;
}

/**
 * 渲染按效果档分区的算子库（06 子计划 6.5-01）。
 * @param props 见 `OperatorPaletteProps`
 * @returns 调色板区块
 */
export function OperatorPalette({ onAdd, onDragStart, draggingKind, isReadOnly }: OperatorPaletteProps) {
  const { t } = useTranslation();
  const { dead } = deskReason(t, 'workflow.operator');
  return (
    <div className="mt-3 rounded-xl border border-line bg-ink-850/60 p-3" data-testid="operator-palette">
      <h4 className="text-xs font-semibold text-slate-300">{t('workflow.operator.paletteHeading')}</h4>
      <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{t('workflow.operator.editHint')}</p>
      {isReadOnly ? (
        <p className="mt-1 text-[11px] text-amber" data-testid="palette-readonly">
          {t('workflow.operator.readOnlyHint')}
        </p>
      ) : null}
      <div className="mt-2 space-y-2">
        {groupOperatorsByEffect().map((group) => (
          <div
            key={group.effect}
            data-testid="palette-group"
            data-effect={group.effect}
            className={`rounded-lg border px-2 py-1.5 ${EFFECT_TONE_CLASS[group.effect]}`}
          >
            <EffectChip effect={group.effect}>{t(`workflow.operator.effect.${group.effect}`)}</EffectChip>
            {/* 分区之内仍按分类排（5.10-03 的那份登记顺序在这里仍然读得出来），一行一类 */}
            <div className="mt-1.5 space-y-1">
              {groupOperatorsByCategory(group.operators).map((categoryGroup) => (
                <div
                  key={categoryGroup.category}
                  data-testid="palette-category"
                  data-category={categoryGroup.category}
                  className="flex flex-wrap items-center gap-1.5"
                >
                  <span className="w-16 shrink-0 text-[10px] tracking-wide text-slate-500">
                    {t(`workflow.operator.category.${categoryGroup.category}`)}
                  </span>
                  {categoryGroup.operators.map((descriptor) => {
                    const Icon = operatorIconOf(descriptor.icon);
                    const isDragOrigin = draggingKind === descriptor.kind;
                    return (
                      // 键色跟随所在分区的效果档（jade/amber/seal），归属规则与分区色同源一份映射（§5、§2.2）。
                      // `draggable={false}`：不关掉浏览器的原生拖放，按下之后文字会被拖成一段选中文本，
                      // 我们的 mousemove 序列当场断掉（6.5-04 走的是鼠标事件那一族，与画布上格子挪位同源）。
                      <DeskButton
                        key={descriptor.kind}
                        action="palette-add"
                        variant={EFFECT_BUTTON_VARIANT[descriptor.effect]}
                        compact
                        markers={{ kind: descriptor.kind, ...(isDragOrigin ? { dragging: 'true' } : {}) }}
                        className={isDragOrigin ? DRAG_ORIGIN_CLASS : ''}
                        draggable={false}
                        onMouseDown={(event) => {
                          // 只读期间连起手都不给：运行中改图会换指纹（5.10-11），拖与点同一条编辑面。
                          if (isReadOnly) return;
                          onDragStart?.(descriptor, event);
                        }}
                        {...dead(isReadOnly ? 'READ_ONLY' : undefined)}
                        onClick={() => onAdd(descriptor)}
                      >
                        <Icon size={11} />
                        {t(descriptor.titleKey)}
                      </DeskButton>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
