/**
 * 分派侧的算子读数（spec 5.10-03 的第四处「执行器分派」）。
 *
 * 描述表本体在 `@auto-cc/core`（渲染层与 workflow 都要读，见 `core/src/operators.ts` 的头注），
 * 这一层只放**workflow 才需要**的两件事：把未登记 kind 说成结构化失败，以及把「节点声明的危险度」
 * 与「描述表登记的危险度」对齐——后者是真护栏：外发节点若能把 `effect` 写成 `read`，
 * 额度闸门与「外发步恒一次重试」都会跟着失效（spec 5.7-04），所以这里不信任计划里的自述。
 */
import {
  AppError,
  WORKFLOW_OPERATORS,
  type OperatorDescriptor,
  type WorkflowExecutorRegistry,
  type WorkflowNodeSpec,
} from '@auto-cc/core';

/**
 * 按 kind 取算子描述，取不到就是结构化失败。
 * @param kind 节点声明的执行器名
 * @param descriptors 描述表（默认可见；测试与后续片可注入扩展表，入口只有一个——§2.5）
 * @returns 该算子的完整描述
 * @throws `INVALID_ARGUMENT` 且列出可用 kind——「配置里多打了一个字母」必须一眼看出来，
 *         不能表现为「节点一直 pending」
 */
export function operatorOf(
  kind: string,
  descriptors: readonly OperatorDescriptor[] = WORKFLOW_OPERATORS,
): OperatorDescriptor {
  const descriptor = descriptors.find((candidate) => candidate.kind === kind);
  if (!descriptor) {
    const available = descriptors.map((candidate) => candidate.kind);
    throw new AppError(
      'INVALID_ARGUMENT',
      `未登记的算子 ${kind}，可选：${available.join('、')}`,
      'workflow.operators',
      {
        kind,
        available,
      },
    );
  }
  return descriptor;
}

/** 一个节点的分派读数：runner 与保存前校验要问的三件事，一次问齐。 */
export type OperatorDispatchBinding = {
  nodeId: string;
  kind: string;
  /** **以描述表为准**的危险度；与节点自述不一致时 `effectMismatch` 为真。 */
  effect: WorkflowNodeSpec['effect'];
  /** 出口句柄（多出口算子在 5.10-d/f 才画得出分支边）。 */
  outputs: readonly string[];
  /** 登记处此刻有没有这个 kind 的执行器实现（mock 链与真平台包在这一处走同一条路）。 */
  hasExecutor: boolean;
};

/**
 * 把一个节点声明收成「能分派吗、按什么危险度播报、有几个出口」的读数。
 * @param spec 补全默认值之后的节点声明
 * @param registry 执行器登记处（由各能力包在运行期写入）
 * @param descriptors 描述表（默认可见）
 * @returns 分派读数；kind 未登记时不抛，用 `hasExecutor:false` 如实带出——调用方（d 片的保存前校验、
 *          f 片的 runner）决定是拒绝还是等实现，这里不替它们决定
 * @throws `INVALID_ARGUMENT` kind 在描述表里没有（未知算子），或 effect 与描述表冲突
 */
export function dispatchBindingFor(
  spec: WorkflowNodeSpec,
  registry: WorkflowExecutorRegistry,
  descriptors: readonly OperatorDescriptor[] = WORKFLOW_OPERATORS,
): OperatorDispatchBinding {
  const descriptor = operatorOf(spec.kind, descriptors);
  if (spec.effect !== descriptor.effect) {
    throw new AppError(
      'INVALID_ARGUMENT',
      `节点 ${spec.id} 的副作用与算子 ${spec.kind} 的登记不一致`,
      'workflow.operators',
      {
        nodeId: spec.id,
        kind: spec.kind,
        declared: spec.effect,
        registered: descriptor.effect,
      },
    );
  }
  return {
    nodeId: spec.id,
    kind: spec.kind,
    effect: descriptor.effect,
    outputs: descriptor.outputs,
    hasExecutor: registry.resolve(spec.kind) !== null,
  };
}
