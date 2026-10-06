/**
 * 算子库调色板（spec 5.10-03 的第一处派生读者 + 06 子计划 6.5-01 的效果色分区）。
 *
 * 列表、分区、图标、危险度徽标**全部**来自 `WORKFLOW_OPERATORS`：这里不出现任何一只算子的名字，
 * 也不出现「哪只算子能放在这一栏」的本地判断。加一只算子的唯一动作是往描述表里加一行（U 用例
 * `operators.test.ts` 就是照这条判据写的）。
 *
 * 分区依据是**副作用档**（06 稿的三色归属：读=jade / 本机写=amber / 外发=seal），因为用户在这一栏
 * 要回答的第一问是「这一步会不会离开这台机器」；分类退到分区内的一行行标签，两层都仍由描述表派生。
 */
import { useTranslation } from 'react-i18next';
import { groupOperatorsByCategory, groupOperatorsByEffect, type OperatorDescriptor } from '@auto-cc/shared';
import { EffectChip, EFFECT_TONE_CLASS } from './ui/controls';
import { operatorIconOf } from './operator-icons';

export interface OperatorPaletteProps {
  /** 点中一格就把整份描述交给画布建节点：id/危险度/出口/参数初值都由画布按描述表算。 */
  onAdd: (descriptor: OperatorDescriptor) => void;
  /** 只读（spec 5.10-11：正在跑的时候不许改图）——按钮禁用并在段末写清原因 */
  isReadOnly: boolean;
}

/**
 * 渲染按效果档分区的算子库（06 子计划 6.5-01）。
 * @param props 见 `OperatorPaletteProps`
 * @returns 调色板区块
 */
export function OperatorPalette({ onAdd, isReadOnly }: OperatorPaletteProps) {
  const { t } = useTranslation();
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
                    return (
                      <button
                        key={descriptor.kind}
                        type="button"
                        data-action="palette-add"
                        data-kind={descriptor.kind}
                        disabled={isReadOnly}
                        onClick={() => onAdd(descriptor)}
                        className="flex items-center gap-1 rounded-md border border-current/40 bg-ink-900/70 px-2 py-1 text-[11px] transition-[filter,transform] duration-150 enabled:hover:brightness-125 enabled:active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <Icon size={11} />
                        {t(descriptor.titleKey)}
                      </button>
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
