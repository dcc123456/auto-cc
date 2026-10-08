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
import { DeskButton, DeskCheck, DeskField, DeskSelect } from './ui/controls';

export interface OperatorParamFormProps {
  /** 该节点的算子描述（字段、必填、枚举候选都由它来） */
  descriptor: OperatorDescriptor;
  /** 节点当前已提交的参数；作为草稿的初值 */
  params: Record<string, string | number | boolean>;
  /** 仅在校验通过时回调，收到的就是可以写进 `WorkflowNodeSpec.params` 的形状 */
  onCommit: (params: Record<string, string | number | boolean>) => void;
  /**
   * 只读（spec 5.10-11：正在跑的时候画布只读）。
   * 判据不是"看着不舒服"：改参数会换指纹，而 5.10-07 要的正是「计划已修改 → 旧 run 不可续跑」，
   * 所以运行期间界面上根本不该存在这条路。
   */
  isReadOnly: boolean;
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
export function OperatorParamForm({ descriptor, params, onCommit, isReadOnly }: OperatorParamFormProps) {
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
    <div className="mt-3 rounded-xl border border-line bg-ink-950/40 p-3" data-testid="operator-param-form">
      <h4 className="text-xs font-semibold text-slate-300">{t('workflow.operator.paramHeading')}</h4>
      <p className="mt-1 text-[11px] text-slate-500">
        {t(descriptor.titleKey)} · {t('workflow.operator.paramHint')}
      </p>
      {isReadOnly ? (
        <p className="mt-1 text-[11px] text-amber" data-testid="param-form-readonly">
          {t('workflow.operator.readOnlyHint')}
        </p>
      ) : null}
      {/* 单列摆（09 稿 4-B 那一栏是一行一字段）：这张表单现在的宿主是 420px 抽屉，
          旧的 `sm:grid-cols-2` 按**视口**断列，于是 1200px 窗口里它照样拆成两列、
          每列只剩 177px，枚举候选与数字单位都被截断。 */}
      <div className="mt-2 grid gap-2">
        {fields.map((field) => {
          const isInvalid = invalidFields.includes(field.name);
          const label = t(`workflow.param.${descriptor.kind}.${field.name}`, { defaultValue: field.name });
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
                {field.required ? <span className="text-seal">*</span> : null}
              </span>
              {/* 控件按派生出来的类型三选一：布尔走勾选框、枚举走 select（候选来自 schema，
                  界面不另存一份平台名）、其余走文本/数字输入。加一只算子不需要动这几行。 */}
              {field.type === 'boolean' ? (
                <DeskCheck
                  action={`param-${field.name}`}
                  disabled={isReadOnly}
                  checked={draft[field.name] === 'true'}
                  onCheckedChange={(isChecked) => edit(field.name, isChecked ? 'true' : 'false')}
                  className="mt-1"
                />
              ) : field.type === 'enum' ? (
                <DeskSelect
                  action={`param-${field.name}`}
                  value={draft[field.name] ?? ''}
                  disabled={isReadOnly}
                  aria-invalid={isInvalid}
                  onValueChange={(value) => edit(field.name, value)}
                  isInvalid={isInvalid}
                  className="mt-1 w-full"
                >
                  {field.options.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </DeskSelect>
              ) : (
                <DeskField
                  action={`param-${field.name}`}
                  type={field.type === 'number' ? 'number' : 'text'}
                  value={draft[field.name] ?? ''}
                  disabled={isReadOnly}
                  aria-invalid={isInvalid}
                  onValueChange={(value) => edit(field.name, value)}
                  isInvalid={isInvalid}
                  className="mt-1 w-full"
                />
              )}
              {isInvalid ? (
                <span className="mt-1 block text-[10px] text-seal">{t('workflow.operator.rejectRequired')}</span>
              ) : null}
            </label>
          );
        })}
      </div>
      <div className="mt-2 flex items-center gap-2">
        {/* 参数落到的是这张图（本机），不是外面：琥珀档。 */}
        <DeskButton
          action="param-save"
          variant="amber"
          compact
          onClick={commit}
          disabled={isReadOnly}
          disabledReason={isReadOnly ? 'READ_ONLY' : undefined}
          disabledReasonLabel={isReadOnly ? t('workflow.operator.reason.READ_ONLY') : undefined}
        >
          {t('workflow.operator.save')}
        </DeskButton>
        {isSaved ? (
          <span className="text-[10px] text-jade" data-testid="param-form-saved">
            {t('workflow.operator.savedHint')}
          </span>
        ) : null}
        {invalidFields.length > 0 ? (
          <span className="text-[10px] text-seal" data-testid="param-form-rejected">
            {t('workflow.operator.rejectedHint')}
          </span>
        ) : null}
      </div>
    </div>
  );
}
