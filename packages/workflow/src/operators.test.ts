/**
 * 算子描述表的派生用例（spec 5.10-03 / 5.10-04）。
 *
 * 判据的落点是「**只改一处描述表**」：加一只 mock 算子之后，调色板分组、节点渲染读数、
 * 参数表单字段、分派绑定四处都跟着出现它——四处共用同一份输入，才谈得上「唯一登记处」。
 * 分派用的小登记处是 `WorkflowExecutorRegistry` 契约的测试替身（Map 三份方法），
 * 真服务的行为由 `executors.ts` 自己的用例覆盖，这里测的是「kind 与危险度从表里来」这一条。
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  WORKFLOW_OPERATORS,
  groupOperatorsByCategory,
  operatorByKind,
  operatorParamDefaults,
  operatorParamFields,
  validateOperatorParams,
  type OperatorDescriptor,
  type OperatorParamField,
  type WorkflowExecutorRegistry,
  type WorkflowNodeExecutor,
  type WorkflowNodeSpec,
} from '@auto-cc/core';
import { WORKFLOW_PLANS, buildPlan } from './plan.js';
import { dispatchBindingFor, operatorOf } from './operators.js';

/** 一只什么都没做的算子，用来回答「加一行描述表，四处有没有同时看见」。 */
const MOCK_ECHO: OperatorDescriptor = {
  kind: 'mock.echo',
  category: 'demo',
  titleKey: 'workflow.operator.mock.echo.title',
  effect: 'read',
  icon: 'search',
  outputs: ['default', 'retry'],
  params: z.strictObject({
    text: z.string().min(1),
    mode: z.enum(['loud', 'quiet']).default('loud'),
    verbose: z.boolean().optional(),
  }),
};

/**
 * 造一份符合 `WorkflowExecutorRegistry` 契约的最小登记处。
 * @param initial 预登记若干 kind
 * @returns 登记处替身（`register` 后写覆盖、`resolve` 未登记回 null，与真服务同口径）
 */
function makeRegistry(initial: readonly string[] = []): WorkflowExecutorRegistry {
  const table = new Map<string, WorkflowNodeExecutor>();
  for (const kind of initial) table.set(kind, async () => {});
  return {
    register: (kind, executor) => {
      table.set(kind, executor);
    },
    unregister: (kind) => table.delete(kind),
    resolve: (kind) => table.get(kind) ?? null,
    list: () => [...table.keys()],
  };
}

/** 一个最小节点声明，用于问分派读数。 */
function nodeSpec(patch: Partial<WorkflowNodeSpec> = {}): WorkflowNodeSpec {
  return {
    id: 'mock-1',
    kind: 'mock.echo',
    target: '',
    params: { text: 'hi' },
    effect: 'read',
    retryTimes: null,
    requiresHuman: false,
    ...patch,
  };
}

describe('算子描述表本身', () => {
  it('内置七只算子的 kind 与 titleKey 都唯一，且每只都能派生出表单字段', () => {
    const kinds = WORKFLOW_OPERATORS.map((descriptor) => descriptor.kind);
    const titleKeys = WORKFLOW_OPERATORS.map((descriptor) => descriptor.titleKey);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(new Set(titleKeys).size).toBe(titleKeys.length);
    for (const descriptor of WORKFLOW_OPERATORS) {
      expect(operatorParamFields(descriptor.params).length).toBeGreaterThan(0);
    }
  });

  it('描述表覆盖三条内置计划用到的每一个 kind，多出来的只有那只分支演示', () => {
    const planKinds = new Set<string>();
    for (const input of Object.values(WORKFLOW_PLANS)) {
      for (const node of buildPlan(input).nodes) planKinds.add(node.kind);
    }
    // 单向包含而不是相等：`demo.branch`（5.10-k / 裁定①）**刻意不进任何内置计划**——
    // 内置那三条是线性 `plan_json`，投影出来的图没有分支边，把这只塞进去只会多一格永远走 yes 的死格子。
    // 它存在的意义是让画布长出第二只出口点，从而截得到 5.10-08/09/13 那三张分支图。
    expect([...WORKFLOW_OPERATORS.map((d) => d.kind)].sort()).toEqual([...planKinds, 'demo.branch'].sort());
  });

  it('全表只有一只多出口算子，且它的句柄就是 U 用例在读的 yes / no', () => {
    const multi = WORKFLOW_OPERATORS.filter((descriptor) => descriptor.outputs.length > 1);
    expect(multi.map((descriptor) => descriptor.kind)).toEqual(['demo.branch']);
    expect(operatorByKind('demo.branch')?.outputs).toEqual(['yes', 'no']);
  });
});

describe('5.10-03 唯一登记处：只改一处描述表，四处同时生效', () => {
  it('加一只 mock 算子后调色板 / 节点渲染 / 参数表单 / 分派四处都出现它', () => {
    const table = [...WORKFLOW_OPERATORS, MOCK_ECHO];
    const registry = makeRegistry();
    registry.register(MOCK_ECHO.kind, async () => {});

    // ① 调色板：分组里多出一格，且没有新开分组
    const demoGroup = groupOperatorsByCategory(table).find((group) => group.category === 'demo');
    expect(demoGroup?.operators.map((descriptor) => descriptor.kind)).toEqual([
      'demo.flaky',
      'demo.branch',
      'mock.echo',
    ]);
    expect(groupOperatorsByCategory(table).length).toBe(groupOperatorsByCategory().length);

    // ② 节点渲染：标题键、图标、出口数都来自同一处声明
    const rendered = operatorByKind('mock.echo', table);
    expect(rendered?.titleKey).toBe('workflow.operator.mock.echo.title');
    expect(rendered?.icon).toBe('search');
    expect(rendered?.outputs).toEqual(['default', 'retry']);

    // ③ 参数表单：字段与类型由 zod 派生
    const fieldShapes = (rendered ? operatorParamFields(rendered.params) : []).map((field: OperatorParamField) => [
      field.name,
      field.type,
      field.required,
    ]);
    expect(fieldShapes).toEqual([
      ['text', 'string', true],
      ['mode', 'enum', false],
      ['verbose', 'boolean', false],
    ]);

    // ④ 分派：危险度与出口取自描述表，登记处只回答「有没有实现」
    expect(dispatchBindingFor(nodeSpec(), registry, table)).toEqual({
      nodeId: 'mock-1',
      kind: 'mock.echo',
      effect: 'read',
      outputs: ['default', 'retry'],
      hasExecutor: true,
    });
  });

  it('登记处缺实现时分派读数如实带出 hasExecutor:false，而不是替它造一个', () => {
    expect(dispatchBindingFor(nodeSpec(), makeRegistry(), [...WORKFLOW_OPERATORS, MOCK_ECHO]).hasExecutor).toBe(false);
  });

  it('未登记的 kind 结构化失败并列出可用算子', () => {
    expect(() => operatorOf('no.such.op')).toThrow(/未登记/);
    expect(() => operatorOf('no.such.op')).toThrow(/jd\.capture/);
  });

  it('节点把外发算子的危险度写成 read 一律拒绝——闸门读的是这一处', () => {
    const deliverSpec = nodeSpec({ kind: 'resume.deliver', effect: 'read', params: { platform: 'boss', job: '1001' } });
    expect(() => dispatchBindingFor(deliverSpec, makeRegistry(['resume.deliver']))).toThrow(/副作用/);
  });
});

describe('5.10-04 参数表单字段与校验', () => {
  it('必填留空 → 拒绝提交且点名该字段，红标依据是字段名而不是文案', () => {
    const capture = operatorByKind('jd.capture');
    expect(capture).toBeDefined();
    const result = validateOperatorParams(capture!, { query: '', city: '上海', target: '3' });
    expect(result.ok).toBe(false);
    expect(result.invalidFields).toEqual(['query']);
    expect(result.params).toEqual({});
  });

  it('可选项与有默认值的字段留空都算填过，参数取 schema 补全后的形状', () => {
    const capture = operatorByKind('jd.capture')!;
    expect(validateOperatorParams(capture, { query: '前端', city: '', target: '' })).toEqual({
      ok: true,
      invalidFields: [],
      params: { query: '前端' },
    });
    const list = operatorByKind('jd.list')!;
    expect(validateOperatorParams(list, { limit: '5' }).params).toEqual({ limit: 5 });
  });

  it('数字字段填非数字、枚举字段填表外的值都拒绝', () => {
    const capture = operatorByKind('jd.capture')!;
    expect(validateOperatorParams(capture, { query: '前端', target: '三' }).invalidFields).toEqual(['target']);
    const greet = operatorByKind('greeting.send')!;
    expect(validateOperatorParams(greet, { platform: 'liepin-x', job: '1001' }).invalidFields).toEqual(['platform']);
    // 枚举的候选来自 schema，界面不另存一份平台名
    expect(operatorParamFields(greet.params).find((field) => field.name === 'platform')?.options).toEqual([
      'boss',
      'liepin',
    ]);
  });

  it('超出 schema 上限的值在提交前就拦下（表单不是唯一一道，但要说得清为什么拒）', () => {
    const capture = operatorByKind('jd.capture')!;
    expect(validateOperatorParams(capture, { query: '前端', target: '500' }).ok).toBe(false);
  });

  it('新建节点的初值只带 schema 里声明过的默认值', () => {
    expect(operatorParamDefaults(MOCK_ECHO)).toEqual({ mode: 'loud' });
    expect(operatorParamDefaults(operatorByKind('jd.capture')!)).toEqual({});
  });

  it('参数用了表单画不出来的形状（数组）就装配期抛，而不是让界面画一只填不对的控件', () => {
    const arrayParams = { ...MOCK_ECHO, params: z.strictObject({ tags: z.array(z.string()) }) };
    expect(() => operatorParamFields(arrayParams.params)).toThrow(/不支持的类型/);
  });
});

describe('描述表与既有计划读数对得上', () => {
  it('三条内置计划的每个节点：kind 已登记、effect 与描述表一致、params 过 schema', () => {
    const registry = makeRegistry(WORKFLOW_OPERATORS.map((descriptor) => descriptor.kind));
    for (const input of Object.values(WORKFLOW_PLANS)) {
      for (const spec of buildPlan(input).nodes) {
        const descriptor = operatorOf(spec.kind);
        expect(descriptor.effect).toBe(spec.effect);
        expect(descriptor.params.safeParse(spec.params).success).toBe(true);
        expect(dispatchBindingFor(spec, registry).hasExecutor).toBe(true);
      }
    }
  });
});
