/**
 * 算子库调色板（spec 5.10-03 的第一处派生读者）。
 *
 * 列表、分组、图标、危险度徽标**全部**来自 `WORKFLOW_OPERATORS`：这里不出现任何一只算子的名字，
 * 也不出现「哪只算子能放在这一栏」的本地判断。加一只算子的唯一动作是往描述表里加一行（U 用例
 * `operators.test.ts` 就是照这条判据写的）。
 */
import { useTranslation } from 'react-i18next';
import { groupOperatorsByCategory, type OperatorDescriptor } from '@auto-cc/shared';
import { operatorIconOf } from './operator-icons';

export interface OperatorPaletteProps {
  /** 点中一格就把整份描述交给画布建草稿节点：id/危险度/出口/参数初值都由画布按描述表算。 */
  onAdd: (descriptor: OperatorDescriptor) => void;
}

/**
 * 渲染按分类分组的算子库。
 * @param onAdd 加入画布的回调
 * @returns 调色板区块
 */
export function OperatorPalette({ onAdd }: OperatorPaletteProps) {
  const { t } = useTranslation();
  return (
    <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/40 p-3" data-testid="operator-palette">
      <h4 className="text-xs font-semibold text-slate-300">{t('workflow.operator.paletteHeading')}</h4>
      <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{t('workflow.operator.editHint')}</p>
      <div className="mt-2 flex flex-wrap items-start gap-x-4 gap-y-2">
        {groupOperatorsByCategory().map((group) => (
          <div
            key={group.category}
            className="flex items-center gap-1"
            data-testid="palette-group"
            data-category={group.category}
          >
            <span className="text-[10px] uppercase tracking-wide text-slate-500">
              {t(`workflow.operator.category.${group.category}`)}
            </span>
            {group.operators.map((descriptor) => {
              const Icon = operatorIconOf(descriptor.icon);
              return (
                <button
                  key={descriptor.kind}
                  type="button"
                  data-action="palette-add"
                  data-kind={descriptor.kind}
                  onClick={() => onAdd(descriptor)}
                  className="flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-800"
                >
                  <Icon size={11} />
                  {t(descriptor.titleKey)}
                  <span className="rounded bg-slate-800 px-1 text-[10px] text-slate-400">
                    {t(`workflow.operator.effect.${descriptor.effect}`)}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
