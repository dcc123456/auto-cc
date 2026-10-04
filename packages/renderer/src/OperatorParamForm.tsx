/**
 * 参数表单（spec 5.10-04 的落点）：**一只**通用组件，字段全部由算子的 zod schema 派生。
 *
 * 这一片刻意不出现任何 per-算子 的表单文件——如果每只算子配一只表单，描述表就只是给人看的注释，
 * 「加一行四处生效」会变成「加一行还得再写一个文件」。
 * 校验走 `validateOperatorParams`（core，与 workflow 的保存前校验同一份实现，AGENTS.md §2.2）：
 * 必填留空即在那一格红标并**拒绝把参数写回节点**，界面上不存在「红着也能保存」这条路。
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { operatorParamFields, validateOperatorParams, type OperatorDescriptor } from '@auto-cc/shared';

export interface OperatorParamFormProps {
  /** 该草稿节点的算子描述（字段、必填、枚举候选都由它来） */
  descriptor: OperatorDescriptor;
  /** 节点当前已提交的参数；作为草稿的初值 */
  params: Record<string, string | number | boolean>;
  /** 仅在校验通过时回调，收到的就是可以写进 `WorkflowNodeSpec.params` 的形状 */
  onCommit: (params: Record<string, string | number | boolean>) => void;
}

/**
 * 把节点参数换算成表单里的文本（表单只在文本形态下才知道「留空」是什么）。
 * @param descriptor 算子描述
 * @param params 节点当前参数
 * @returns 字段名 → 文本草稿
 */
function draftFromParams(descriptor: OperatorDescriptor, params: Record<string, string | number | boolean>) {
  const draft: Record<string, string> = {};
  for (const field of operatorParamFields(descriptor.params)) {
    const current = params[field.name];
    draft[field.name] = current === undefined ? '' : String(current);
  }
  return draft;
}

/**
 * 渲染参数表单。
 * @param props 见 `OperatorParamFormProps`
 * @returns 按 schema 顺序排列的字段行 + 保存按钮
 */
export function OperatorParamForm({ descriptor, params, onCommit }: OperatorParamFormProps) {
  const { t } = useTranslation();
  const fields = useMemo(() => operatorParamFields(descriptor.params), [descriptor]);
  const [draft, setDraft] = useState<Record<string, string>>(() => draftFromParams(descriptor, params));
  const [invalidFields, setInvalidFields] = useState<readonly string[]>([]);
  const [isSaved, setIsSaved] = useState(false);

  /**
   * 改任一字段：清掉红标与「已保存」提示——红标的含义是「上一次提交被拒」，
   * 用户已经在改了，留着旧红标会让人以为还没填。
   * @param name 字段名
   * @param text 新的文本值（布尔字段传 'true'/'false'）
   */
  function edit(name: string, text: string) {
    setDraft((previous) => ({ ...previous, [name]: text }));
    setInvalidFields([]);
    setIsSaved(false);
  }

  /** 提交：只在描述表校验通过时才把参数交回画布。 */
  function commit() {
    const result = validateOperatorParams(descriptor, draft);
    if (!result.ok) {
      setInvalidFields(result.invalidFields);
      setIsSaved(false);
      return;
    }
    setInvalidFields([]);
    setIsSaved(true);
    onCommit(result.params);
  }

  return (
    <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/40 p-3" data-testid="operator-param-form">
      <h4 className="text-xs font-semibold text-slate-300">{t('workflow.operator.paramHeading')}</h4>
      <p className="mt-1 text-[11px] text-slate-500">
        {t(descriptor.titleKey)} · {t('workflow.operator.paramHint')}
      </p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {fields.map((field) => {
          const isInvalid = invalidFields.includes(field.name);
          const label = t(`workflow.param.${descriptor.kind}.${field.name}`, { defaultValue: field.name });
          const borderClass = isInvalid ? 'border-rose-500 ring-1 ring-rose-500/40' : 'border-slate-700';
          return (
            <label
              key={field.name}
              className="block text-[11px] text-slate-300"
              data-testid="param-field"
              data-field-name={field.name}
              data-invalid={isInvalid}
            >
              <span className="flex items-center gap-1">
                {label}
                {field.required ? <span className="text-rose-400">*</span> : null}
              </span>
              {/* 控件按派生出来的类型三选一：布尔走勾选框、枚举走 select（候选来自 schema，
                  界面不另存一份平台名）、其余走文本/数字输入。加一只算子不需要动这几行。 */}
              {field.type === 'boolean' ? (
                <input
                  type="checkbox"
                  checked={draft[field.name] === 'true'}
                  onChange={(event) => edit(field.name, event.target.checked ? 'true' : 'false')}
                  className="mt-1 h-3.5 w-3.5 rounded border-slate-700 bg-slate-900"
                />
              ) : field.type === 'enum' ? (
                <select
                  value={draft[field.name] ?? ''}
                  aria-invalid={isInvalid}
                  onChange={(event) => edit(field.name, event.target.value)}
                  className={`mt-1 w-full rounded-md border bg-slate-900 px-2 py-1 text-[11px] text-slate-100 ${borderClass}`}
                >
                  {field.options.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type={field.type === 'number' ? 'number' : 'text'}
                  value={draft[field.name] ?? ''}
                  aria-invalid={isInvalid}
                  onChange={(event) => edit(field.name, event.target.value)}
                  className={`mt-1 w-full rounded-md border bg-slate-900 px-2 py-1 text-[11px] text-slate-100 outline-none focus:border-sky-700 ${borderClass}`}
                />
              )}
              {isInvalid ? (
                <span className="mt-1 block text-[10px] text-rose-400">{t('workflow.operator.rejectRequired')}</span>
              ) : null}
            </label>
          );
        })}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          data-action="param-save"
          onClick={commit}
          className="rounded-md border border-sky-900 px-2 py-1 text-[11px] text-sky-300 hover:bg-sky-950"
        >
          {t('workflow.operator.save')}
        </button>
        {isSaved ? (
          <span className="text-[10px] text-emerald-400" data-testid="param-form-saved">
            {t('workflow.operator.savedHint')}
          </span>
        ) : null}
        {invalidFields.length > 0 ? (
          <span className="text-[10px] text-rose-400" data-testid="param-form-rejected">
            {t('workflow.operator.rejectedHint')}
          </span>
        ) : null}
      </div>
    </div>
  );
}
