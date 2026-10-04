/**
 * 计划与图的**同一把指纹**（spec 2.4-01 / 5.10-06，plan §7.8.2 裁定二）。
 *
 * 为什么单独一个文件：`plan.ts` 与 `graph.ts` 都要算指纹，而它必须是同一个口径——
 * 一份线性计划与它的图投影算出两个值，就等于同一份语义有两条真相（AGENTS.md §2.5），
 * 而 5.10-07「计划改过的旧 run 不许续跑」判的就是这个值。哈希原语从 `plan.ts` 整体搬过来，
 * 不留第二份实现。
 */
import type { WorkflowEdgeView, WorkflowNodeSpec } from '@auto-cc/core';

/**
 * 稳定哈希：FNV-1a 32 位，输出 8 位十六进制。
 *
 * 选它而不是 `node:crypto` 的 sha256：这条指纹只用来判「同一份计划文本」（plan §11.2 的
 * 「跨计划串档」一条），要的是**短、确定、零依赖**，不是抗碰撞；而 crypto 摘要写进日志反而难读。
 * @param text 已经规范化（键排序）的文本
 * @returns 8 位小写十六进制
 */
export function fnv1a32(text: string): string {
  let hash = 0x811c_9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    // `Math.imul` 给出 32 位截断乘法，`>>> 0` 把结果收回无符号域（JS 位运算是带符号的）。
    hash = Math.imul(hash, 0x0100_0193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * 把值转成**键有序**的 JSON 文本。
 *
 * 必须排序：计划是从库里读回来的，`JSON.parse` 之后键序按写入时的文本走，
 * 不排序的话同一份计划两次序列化得到不同指纹，续跑就会误判成「跨计划串档」。
 * @param value 计划节点这类纯 JSON 值（对象/数组/标量）
 * @returns 稳定的 JSON 文本
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * 参与执行身份的那几个节点字段——**写死的清单**，不是"对象长什么样就哈希什么"。
 *
 * 这条区分是 5.10-06 的全部难度所在：节点上以后会挂上只影响"怎么看"的字段
 * （`outputs` 的声明、视图位置、图标），若照整对象哈希，加一个展示字段就会让**历史** run 的
 * 指纹全部对不上，续跑被误判成「计划已修改」。所以新字段要进执行身份，必须显式加进这张表。
 * 今天这七个键与 `WorkflowNodeSpec` 的字段一一对应，因此与 2.4 时代留下的指纹逐字节相同。
 */
const EXECUTION_NODE_FIELDS = [
  'id',
  'kind',
  'target',
  'params',
  'effect',
  'retryTimes',
  'requiresHuman',
] as const satisfies readonly (keyof WorkflowNodeSpec)[];

/**
 * 把节点数组收成"执行身份"读数：只取上面那张清单里的键，顺序固定。
 * @param nodes 补全默认值之后的节点数组
 * @returns 用于哈希的数组，每个元素是键固定的对象
 */
function executionIdentity(nodes: readonly WorkflowNodeSpec[]): Record<string, unknown>[] {
  return nodes.map((node) => {
    const identity: Record<string, unknown> = {};
    for (const field of EXECUTION_NODE_FIELDS) identity[field] = node[field];
    return identity;
  });
}

/**
 * 边数组是否就是「按节点顺序连成的一条链」（也就是派生物，不是新事实）。
 * @param nodes 图里的节点（顺序即线性顺序）
 * @param edges 待判定的边
 * @returns 每个节点出度 ≤1、按顺序串成一条链且出口全是 `default` 时为 true
 */
export function isLinearProjection(nodes: readonly WorkflowNodeSpec[], edges: readonly WorkflowEdgeView[]): boolean {
  if (edges.length !== Math.max(nodes.length - 1, 0)) return false;
  return edges.every((edge, index) => {
    const source = nodes[index];
    const target = nodes[index + 1];
    return (
      edge.sourceHandle === 'default' &&
      source !== undefined &&
      target !== undefined &&
      edge.source === source.id &&
      edge.target === target.id
    );
  });
}

/**
 * 算一份计划 / 一张图的指纹（2.4-01 的「可序列化」与 plan §11.3 的「续跑前校验指纹」共用这一处）。
 *
 * 口径两条，缺一不可：
 * ① **线性图与它的源计划同值**——线性那几条边是节点顺序的派生物，不是第二条真相，
 *    所以此时只哈希节点，读数与 2.4 时代留下的历史指纹逐字节相同（不改动一条历史 run 的续跑判据）；
 * ② **一旦有派生之外的边（分支、自定义图），边就是执行语义本身**，必须连边一起哈希，
 *    于是"只挪节点位置"指纹不动、"改一条边"指纹必换（spec 5.10-06 的两半）。
 * @param nodes 补全默认值之后的节点数组
 * @param edges 图的边；省略即按线性读（与 `buildPlan` 的老调用点等价）
 * @returns 8 位十六进制指纹；只与执行语义有关，与计划 id、视图位置都无关
 */
export function graphFingerprint(nodes: readonly WorkflowNodeSpec[], edges?: readonly WorkflowEdgeView[]): string {
  const identity = executionIdentity(nodes);
  if (edges === undefined || isLinearProjection(nodes, edges)) return fnv1a32(canonicalJson(identity));
  return fnv1a32(canonicalJson({ nodes: identity, edges: edges.map((edge) => ({ ...edge })) }));
}
