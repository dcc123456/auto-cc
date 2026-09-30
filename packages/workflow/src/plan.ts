/**
 * 工作流计划的**声明层**（spec 2.4-01）：节点是什么、一条计划怎么序列化成库里的文本。
 *
 * 刻意与执行器解耦：`kind` 只是执行器的名字，runner 按它分派，计划本身不认识任何平台、
 * 也不含任何选择器或 URL。于是 2.4-08 的「mock 适配器跑完整条链」不需要改计划，
 * 而 P5 想加一条「只做择机投递」的计划也只是多一个数据文件。
 */
import { TOOL_EFFECTS, type WorkflowNodeSpec, type WorkflowPlanView } from '@auto-cc/core';
import { z } from 'zod';

/** 节点参数值：计划要能整体 JSON 序列化进库，所以不接受嵌套对象（嵌套就得再设计一层模板引擎）。 */
const nodeParamSchema = z.union([z.string(), z.number(), z.boolean()]);

/**
 * 单个节点的声明形状。
 *
 * 输入侧除 `id`/`kind`/`effect` 外全部可省略，由 schema 补默认值；输出侧再转成
 * `WorkflowNodeSpec`（跨进程视图）时字段齐全，界面和落库看到的都是补全后的版本。
 */
export const workflowNodeSpecSchema = z.strictObject({
  /** 计划内唯一的节点 id，同时是幂等键的一段。 */
  id: z.string().min(1),
  /** 执行器名（如 `jd.capture`）；runner 按它查表分派，不做任何字符串猜测。 */
  kind: z.string().min(1),
  /**
   * 动作对象（如某条 JD 的地址、某个关键词）。
   * 它参与幂等键 `runId+nodeId+target`，所以「同一岗位再抓一次」和「换个岗位再抓」在库里分得开；
   * 纯读节点用空串。
   */
  target: z.string().default(''),
  /** 执行器自己的入参，键值都是标量。 */
  params: z.record(z.string(), nodeParamSchema).default({}),
  /** 副作用分级，复用工具侧那份 `read|local-write|outbound`，不再造第二套危险度。 */
  effect: z.enum(TOOL_EFFECTS),
  /** 本节点失败后额外重试几次；null = 用全局配置（`retryTimes`）。上限 5：再高就是在掩盖站点故障。 */
  retryTimes: z.number().int().min(0).max(5).nullable().default(null),
  /** 声明为人工接管点：失败即停并等用户，不自动重试（验证码/风控一类）。 */
  requiresHuman: z.boolean().default(false),
});

/** 一条计划的声明形状（`fingerprint` 由 `buildPlan` 现算，不接受外部传入）。 */
export const workflowPlanSchema = z.strictObject({
  id: z.string().min(1),
  /** 节点按数组顺序执行；上限 64 是「一条计划不该是一张大图」的护栏（2.4 不做分支/并行）。 */
  nodes: z.array(workflowNodeSpecSchema).min(1).max(64),
  /**
   * 视图里带着的指纹，允许出现在**输入**里只为让「序列化→读回」这条往返不报错（库里存的就是这份文本）。
   * 传进来的值一律不信，`buildPlan` 总是按节点内容重算——否则改过节点却把旧指纹一起存进去，
   * 续跑时的比对就成了一句空话。
   */
  fingerprint: z.string().length(8).optional(),
});

/** zod **输入**侧形状：带默认值的键可省略，计划文件因此只需写它真正关心的字段。 */
export type PlanInput = z.input<typeof workflowPlanSchema>;

/**
 * 稳定哈希：FNV-1a 32 位，输出 8 位十六进制。
 *
 * 选它而不是 `node:crypto` 的 sha256：这条指纹只用来判「同一份计划文本」（plan §11.2 的
 * 「跨计划串档」一条），要的是**短、确定、零依赖**，不是抗碰撞；而 crypto 摘要写进日志反而难读。
 * @param text 已经规范化（键排序）的文本
 * @returns 8 位小写十六进制
 */
function fnv1a32(text: string): string {
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
function canonicalJson(value: unknown): string {
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
 * 算一条计划的指纹（2.4-01 的「可序列化」与 plan §11.3 的「续跑前校验指纹」共用一处实现）。
 * @param nodes 补全默认值之后的节点数组
 * @returns 8 位十六进制指纹；只与节点内容有关，与计划 id 无关
 */
function planFingerprint(nodes: readonly WorkflowNodeSpec[]): string {
  return fnv1a32(canonicalJson(nodes));
}

/**
 * 把一份计划（未校验的外部数据也行）解析成跨进程视图。
 * @param raw 来自配置文件、界面或数据库 JSON 列的原始值
 * @returns 带 `fingerprint` 的计划视图，节点顺序即执行顺序
 * @throws 形状不合（缺 id/kind/effect、节点为空、参数是嵌套对象）或计划内节点 id 重复时以
 *         `INVALID_ARGUMENT` 结构化失败——**不返回半条计划**，否则会落库一条永远跑不动的 run
 */
export function buildPlan(raw: unknown): WorkflowPlanView {
  const parsed = workflowPlanSchema.safeParse(raw);
  if (!parsed.success) {
    throw new TypeError(`工作流计划不合法：${parsed.error.issues.map((item) => item.message).join('；')}`);
  }
  const seen = new Set<string>();
  for (const node of parsed.data.nodes) {
    if (seen.has(node.id)) throw new TypeError(`工作流计划有重名节点 ${node.id}`);
    seen.add(node.id);
  }
  // `params` 的默认值必须在这里补全：落库和界面读到的都应当是补全后的形状，而不是「有时有 key 有时没有」。
  const nodes: WorkflowNodeSpec[] = parsed.data.nodes.map((node) => ({
    id: node.id,
    kind: node.kind,
    target: node.target,
    params: node.params,
    effect: node.effect,
    retryTimes: node.retryTimes,
    requiresHuman: node.requiresHuman,
  }));
  return { id: parsed.data.id, nodes, fingerprint: planFingerprint(nodes) };
}

/**
 * BOSS 主线的第一条计划（spec 2.4-02/03/05 的验收对象）。
 *
 * 三个节点都是**线性**的，且第三个故意是「前两次必失败」的演示节点：
 * 断点续跑要看得见「从第 3 个节点继续」，重试退避要看得见「第 3 次才成功」，
 * 前两个真实节点因此只需承担「已完成不重放」的角色。
 * 执行器实现在 `workflow.runner` 里按 `kind` 注册，本常量不含任何平台细节。
 */
export const BOSS_BASIC_PLAN: PlanInput = {
  id: 'boss-basic',
  nodes: [
    {
      id: 'jd-capture',
      kind: 'jd.capture',
      // 搜索关键词是节点参数而非计划常量：界面/话术要能换词复用同一条计划。
      params: { query: '前端工程师', city: '上海', target: 3 },
      effect: 'read',
    },
    {
      id: 'jd-list',
      kind: 'jd.list',
      params: { limit: 5 },
      effect: 'read',
    },
    {
      id: 'flaky',
      kind: 'demo.flaky',
      // 失败注入节点没有真实外发，但它必须**有 target**：2.4-06 要的「重复执行同节点不重复外发」
      // 只有幂等键真的写进库才算被测到。
      target: 'demo://flaky',
      params: { failTimes: 2 },
      effect: 'local-write',
      retryTimes: 2,
    },
  ],
};
