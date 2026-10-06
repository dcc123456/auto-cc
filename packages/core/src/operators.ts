/**
 * 算子描述表（spec 5.10-03 的「唯一登记处」）：一个节点 `kind` 对外需要被知道的**全部**静态事实。
 *
 * 为什么放在 `@auto-cc/core`：这五处读者分属三层——渲染层的调色板 / 节点格子 / 参数表单（L4）、
 * workflow 的保存前校验与分派读数（L3）、以及各能力包登记执行器时用的那个 kind 字符串（L2）。
 * 依赖方向只许上层依赖下层（AGENTS.md §4.1），而渲染层只允许 import `@auto-cc/shared`
 * （它再复导出 core），所以能同时被这五处读到的位置只有这里（§2.7「跨模块能力一律经 core 复导出」）。
 *
 * 两条口径要写死，免得后面几片把它用歪：
 * - **这是编译期静态表，不是 IPC 载荷**：`params` 是 zod schema 实例，跨进程序列化会丢行为。
 *   e 片的 `workflow.graph.*` 只传图数据（节点/边/视图），调色板在渲染层直接读这张表——
 *   把表搬进 IPC 反而会让「主进程还没登记执行器」与「界面已经能摆出算子」变成两件事。
 * - **它不含执行器实现**：谁实现 `jd.capture` 仍由 platform 包在运行期登记（L2 不能 import L3，
 *   而 2.4-08 的 mock 链要在测试里换掉实现）。表与登记处的差集是 h 片双入口收口时要走的账，
 *   本片不假装已经对上。
 */
import { z } from 'zod';
import { TOOL_EFFECTS, type ToolEffect } from './events.js';

/** 算子分类：调色板按它分组，界面文案取 `workflow.operator.category.<这里的一个>`。 */
export const OPERATOR_CATEGORIES = ['discover', 'outbound', 'resume', 'demo'] as const;

export type OperatorCategory = (typeof OPERATOR_CATEGORIES)[number];

/** 参数表单支持的四种控件类型——由 zod 类型映射而来，渲染层不按算子手写任何表单。 */
export const OPERATOR_PARAM_TYPES = ['string', 'number', 'boolean', 'enum'] as const;

export type OperatorParamType = (typeof OPERATOR_PARAM_TYPES)[number];

/** 一个算子的完整声明。 */
export type OperatorDescriptor = {
  /** 执行器名，同时是 `WorkflowNodeSpec.kind` 与分派键。 */
  kind: string;
  /** 调色板分组。 */
  category: OperatorCategory;
  /** 界面标题的 i18n 键（§5.5：页面上每条文案都走语言包，表里存键不存中文）。 */
  titleKey: string;
  /** 副作用分级：新增节点时由它填进 `WorkflowNodeSpec.effect`，不让用户自己挑危险度。 */
  effect: ToolEffect;
  /** lucide 图标名（§5.3 唯一图标来源）；渲染层按名查表，表里不存 JSX。 */
  icon: string;
  /** 出口句柄名：单出口算子只有 `default`，带条件的算子在这里多一个就多出几枚连接点。 */
  outputs: readonly string[];
  /** 参数 schema（zod 对象）。表单字段与保存前校验都从它派生。 */
  params: z.ZodType;
};

/** 派生出来的表单字段：形状固定，所以表单组件是**一只**而不是每算子一只。 */
export type OperatorParamField = {
  name: string;
  type: OperatorParamType;
  /** 必填 = 既不能省略也没有默认值；界面上留空即在字段上红标并拒绝提交。 */
  required: boolean;
  /** 有无默认值：有默认的字段留空不算「没填」。 */
  hasDefault: boolean;
  /** 默认值（已按类型还原），用于新建节点时的初值。 */
  defaultValue: string | number | boolean | null;
  /** 枚举候选，仅 `type === 'enum'` 时非空。 */
  options: readonly string[];
};

/**
 * 拆掉 zod 的可选/默认包装，拿到真正描述类型的内层 schema。
 *
 * 实测（zod 4.6.5，本机 `packages/core` 内探针）：`ZodOptional` 有 `.unwrap()`，
 * `ZodDefault` 有 `.removeDefault()` 而**没有**可调用的 `.defaultValue()`（值挂在 `_def.defaultValue` 上），
 * `ZodEnum` 的候选在 `.options` 上；`ZodDefault.isOptional()` 返回 true，所以「必填」不能只看这一条。
 * @param schema 字段 schema（可能是 `ZodOptional`/`ZodDefault` 包着的）
 * @returns 剥掉包装后的内层 schema 与「有没有默认值」「默认值」两项读数
 */
function unwrapField(schema: z.ZodTypeAny): { inner: z.ZodTypeAny; hasDefault: boolean; defaultValue: unknown } {
  if (schema instanceof z.ZodDefault) {
    const inner = schema.removeDefault() as z.ZodTypeAny;
    const declared = (schema as unknown as { _def?: { defaultValue?: unknown } })._def?.defaultValue;
    // zod 4（实测 4.6.5）把默认值直接存在 `_def.defaultValue` 上而不是取值函数上，
    // 但两种形态都按公开类型收下来，免得升级后又变成「默认值静默变成 undefined」。
    const resolved = typeof declared === 'function' ? (declared as () => unknown)() : declared;
    return { inner, hasDefault: true, defaultValue: resolved };
  }
  if (schema instanceof z.ZodOptional) {
    return { inner: schema.unwrap() as z.ZodTypeAny, hasDefault: false, defaultValue: null };
  }
  return { inner: schema, hasDefault: false, defaultValue: null };
}

/**
 * 把一只算子的参数 schema 派生成表单字段清单（spec 5.10-04 的「表单由 zod 生成」）。
 *
 * 只认四种类型：`string / number / boolean / enum`。遇到别的 zod 类型（数组、嵌套对象、联合）
 * 就抛——那说明有人给算子加了计划参数表达不了的形状（`WorkflowNodeSpec.params` 只收标量，
 * 见 `plan.ts` 的 `nodeParamSchema`），此时**必须先回去改声明**，而不是让界面画出一只填不对的控件。
 * @param schema 算子的 `params` schema（须为 zod 对象）
 * @returns 按 schema 里声明顺序排列的字段清单
 * @throws 参数 schema 不是对象、或字段类型不在四种之内时抛 `TypeError`（装配期就该发现）
 */
export function operatorParamFields(schema: z.ZodType): readonly OperatorParamField[] {
  if (!(schema instanceof z.ZodObject)) {
    throw new TypeError('算子参数 schema 必须是 zod 对象，否则表单无从生成字段');
  }
  const fields = Object.entries((schema as z.ZodObject<z.ZodRawShape>).shape).map(([name, fieldSchema]) => {
    // zod 4 把 `.shape` 的值标成 `$ZodType`（内部形态），这里要的只是「一条字段 schema」，
    // 所以按公开类型 `ZodTypeAny` 收口——实测（4.6.5）`instanceof` 与 `.isOptional()` 都在这一层可用。
    const { inner, hasDefault, defaultValue } = unwrapField(fieldSchema as z.ZodTypeAny);
    let type: OperatorParamType;
    let options: readonly string[] = [];
    if (inner instanceof z.ZodEnum) {
      type = 'enum';
      options = (inner.options as readonly string[]) ?? [];
    } else if (inner instanceof z.ZodNumber) {
      type = 'number';
    } else if (inner instanceof z.ZodBoolean) {
      type = 'boolean';
    } else if (inner instanceof z.ZodString) {
      type = 'string';
    } else {
      throw new TypeError(`算子参数 ${name} 用了表单不支持的类型，只许 string/number/boolean/enum`);
    }
    return {
      name,
      type,
      required: !hasDefault && !(fieldSchema as z.ZodTypeAny).isOptional(),
      hasDefault,
      defaultValue: (defaultValue as string | number | boolean | null | undefined) ?? null,
      options,
    };
  });
  return fields;
}

/**
 * 校验界面上填的参数（spec 5.10-04 的「必填留空 → 红标且拒绝保存」）。
 *
 * 输入是**表单里的原始字符串/勾选状态**，因为「必填留空」这件事只在这个形态下存在——
 * 一旦按类型转成值，空串就成了合法的 `''`，红标就丢了依据。
 * 拒因文案**不在这里出**：页面上每条文案都要走语言包（§5.5），所以只回字段名，
 * 由界面按 `workflow.operator.rejectRequired` 说话。
 * @param descriptor 目标算子
 * @param rawValues 字段名 → 表单里的原始文本（布尔字段用 'true'/'false'）
 * @returns `ok` 是否可提交、`invalidFields` 该红标的字段名、`params` 通过校验后（已补齐默认值）可写进节点的参数
 */
export function validateOperatorParams(
  descriptor: OperatorDescriptor,
  rawValues: Readonly<Record<string, string>>,
): { ok: boolean; invalidFields: readonly string[]; params: Record<string, string | number | boolean> } {
  const fields = operatorParamFields(descriptor.params);
  const coerced: Record<string, unknown> = {};
  const invalidFields: string[] = [];
  for (const field of fields) {
    const text = rawValues[field.name] ?? '';
    if (text === '') {
      // 留空只在「必填且无默认」时算错；其余情况交给 schema（可选项省略、有默认的用默认值）。
      if (field.required) invalidFields.push(field.name);
      continue;
    }
    if (field.type === 'number') {
      const numeric = Number(text);
      if (!Number.isFinite(numeric)) {
        invalidFields.push(field.name);
        continue;
      }
      coerced[field.name] = numeric;
      continue;
    }
    if (field.type === 'boolean') {
      coerced[field.name] = text === 'true';
      continue;
    }
    if (field.type === 'enum' && !field.options.includes(text)) {
      invalidFields.push(field.name);
      continue;
    }
    coerced[field.name] = text;
  }
  const parsed = descriptor.params.safeParse(coerced);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const name = issue.path[0];
      if (typeof name === 'string' && !invalidFields.includes(name)) invalidFields.push(name);
    }
    return { ok: false, invalidFields, params: {} };
  }
  return {
    ok: invalidFields.length === 0,
    invalidFields,
    params: parsed.data as Record<string, string | number | boolean>,
  };
}

/**
 * 新建节点时的参数初值：只带 schema 里声明过的默认值。
 * @param descriptor 目标算子
 * @returns 可直接写进 `WorkflowNodeSpec.params` 的标量表（没默认的字段留空，让用户填）
 */
export function operatorParamDefaults(descriptor: OperatorDescriptor): Record<string, string | number | boolean> {
  const defaults: Record<string, string | number | boolean> = {};
  for (const field of operatorParamFields(descriptor.params)) {
    if (field.hasDefault && field.defaultValue !== null) defaults[field.name] = field.defaultValue;
  }
  return defaults;
}

/**
 * 按分类分组，供调色板渲染。
 * @param descriptors 描述表（默认用内置这张；测试传「内置 + 一只 mock」来证「改一处四处生效」）
 * @returns 按 `OPERATOR_CATEGORIES` 顺序的分组，空分组不出现
 */
export function groupOperatorsByCategory(
  descriptors: readonly OperatorDescriptor[] = WORKFLOW_OPERATORS,
): readonly { category: OperatorCategory; operators: readonly OperatorDescriptor[] }[] {
  return OPERATOR_CATEGORIES.map((category) => ({
    category,
    operators: descriptors.filter((descriptor) => descriptor.category === category),
  })).filter((group) => group.operators.length > 0);
}

/**
 * 按副作用分级分组，供调色板按「效果色」分区（plan 06 的 6.5-01：会不会离开这台机器，一眼分区）。
 *
 * 与 `groupOperatorsByCategory` 并列而不是替换它：分类回答「这只算子办哪类事」，效果档回答「这一步有多重」，
 * 调色板的分区依据是后者，而算子格子上仍留分类标签（一条信息都不丢）。
 * @param descriptors 描述表（默认内置这张；测试传「内置 + 一只 mock」来证「改一处多处生效」）
 * @returns 按 `TOOL_EFFECTS` 从轻到重的分组，空分组不出现
 */
export function groupOperatorsByEffect(
  descriptors: readonly OperatorDescriptor[] = WORKFLOW_OPERATORS,
): readonly { effect: ToolEffect; operators: readonly OperatorDescriptor[] }[] {
  return TOOL_EFFECTS.map((effect) => ({
    effect,
    operators: descriptors.filter((descriptor) => descriptor.effect === effect),
  })).filter((group) => group.operators.length > 0);
}

/**
 * 按 kind 取算子。
 * @param kind 节点声明里的执行器名
 * @param descriptors 描述表（默认可见，测试可注入扩展表——§2.5 只留一个入口）
 * @returns 找到的算子；未登记时 undefined，由调用方决定是拒绝保存还是报错
 */
export function operatorByKind(
  kind: string,
  descriptors: readonly OperatorDescriptor[] = WORKFLOW_OPERATORS,
): OperatorDescriptor | undefined {
  return descriptors.find((descriptor) => descriptor.kind === kind);
}

/**
 * 内置算子表：现役七只执行器，一条不多一条不少。
 *
 * 参数 schema 是**照着各执行器真正读的键**写的（`jd-capture.ts:340-348`、`jd-store.ts:468`、
 * `greet.ts:284-300`、`deliver.ts:661-676`），不是照着理想形状编的：多一个键就是界面上
 * 一个填了也没人读的框（§2.6）。`platform` 做成枚举是为了表单里出现第四类控件，
 * 取值与 `ToolDescriptor` 那边用的平台名一致。
 */
export const WORKFLOW_OPERATORS: readonly OperatorDescriptor[] = [
  {
    kind: 'jd.capture',
    category: 'discover',
    titleKey: 'workflow.operator.jd.capture.title',
    effect: 'read',
    icon: 'search',
    outputs: ['default'],
    params: z.strictObject({
      query: z.string().min(1),
      city: z.string().min(1).optional(),
      target: z.number().int().min(1).max(50).optional(),
    }),
  },
  {
    kind: 'jd.list',
    category: 'discover',
    titleKey: 'workflow.operator.jd.list.title',
    effect: 'read',
    icon: 'list',
    outputs: ['default'],
    params: z.strictObject({ limit: z.number().int().min(1).max(50).optional() }),
  },
  {
    kind: 'greeting.send',
    category: 'outbound',
    titleKey: 'workflow.operator.greeting.send.title',
    effect: 'outbound',
    icon: 'message-square',
    outputs: ['default'],
    params: z.strictObject({
      platform: z.enum(['boss', 'liepin']),
      job: z.string().min(1),
      title: z.string().min(1).optional(),
      company: z.string().min(1).optional(),
      text: z.string().min(1).optional(),
    }),
  },
  {
    kind: 'resume.deliver',
    category: 'outbound',
    titleKey: 'workflow.operator.resume.deliver.title',
    effect: 'outbound',
    icon: 'send',
    outputs: ['default'],
    params: z.strictObject({
      platform: z.enum(['boss', 'liepin']),
      job: z.string().min(1),
      file: z.string().min(1).optional(),
      title: z.string().min(1).optional(),
      company: z.string().min(1).optional(),
      snapshot: z.string().min(1).optional(),
    }),
  },
  {
    kind: 'resume.customize',
    category: 'resume',
    titleKey: 'workflow.operator.resume.customize.title',
    effect: 'read',
    icon: 'file-text',
    outputs: ['default'],
    params: z.strictObject({
      platform: z.enum(['boss', 'liepin']),
      job: z.string().min(1),
    }),
  },
  {
    kind: 'demo.flaky',
    category: 'demo',
    titleKey: 'workflow.operator.demo.flaky.title',
    effect: 'local-write',
    icon: 'rotate-ccw',
    outputs: ['default'],
    params: z.strictObject({
      url: z.string().min(1),
      failTimes: z.number().int().min(0).max(5).optional(),
    }),
  },
  {
    // 全表**唯一**一只多出口算子（plan §7.8.3-decies 的裁定①）：画布的出口连接点只从这张表取，
    // 所以六只全是 `['default']` 时，活体里连不出分支边，spec 5.10-08/09/13 的 V 半边一张也截不到。
    // 句柄名沿用 U 用例（`runner.test.ts:1205-1404`）已经在读的 `yes` / `no`，不另起一套词。
    kind: 'demo.branch',
    category: 'demo',
    titleKey: 'workflow.operator.demo.branch.title',
    // `read`：它不写库、不出网、不碰平台，因此既不经过额度闸门也不触发风险确认（§7.2 / §7.3）。
    effect: 'read',
    icon: 'git-branch',
    outputs: ['yes', 'no'],
    // 两个数而不是"一个数 + 代码里的常数"：常数写进执行器就是在算子层埋业务规则（plan §8 第一条）。
    // 都带默认值，好让刚从算子库拖出来的格子不必先填表也能跑（首跑走 yes 支）。
    params: z.strictObject({
      value: z.number().int().default(1),
      threshold: z.number().int().default(1),
    }),
  },
];
