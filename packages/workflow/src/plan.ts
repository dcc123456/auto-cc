/**
 * 工作流计划的**声明层**（spec 2.4-01）：节点是什么、一条计划怎么序列化成库里的文本。
 *
 * 刻意与执行器解耦：`kind` 只是执行器的名字，runner 按它分派，计划本身不认识任何平台、
 * 也不含任何选择器或 URL。于是 2.4-08 的「mock 适配器跑完整条链」不需要改计划，
 * 而 P5 想加一条「只做择机投递」的计划也只是多一个数据文件。
 */
import { AppError, TOOL_EFFECTS, type WorkflowNodeSpec, type WorkflowPlanView } from '@auto-cc/core';
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
 * 把「库里存的一段计划文本 + 当时登记的指纹」收成可信本体。
 *
 * 这条判据有**两个**读路要它：run 行的 `plan_json`（2.4-05 的断点续跑）与 `workflow_plans` 的行
 * （5.4-06 的自定义计划）。落库之后文本可能被外部改坏，也可能节点变了而指纹列还是旧值——那时
 * 「第 i 个节点」已经不是当初那个节点，宁可拒绝读数，也不能按一个没人核对过的下标继续跑。
 * 重算机器只写这一份（AGENTS.md §2.2）：两条读路分开写迟早漂成两个口径，而「按坏计划开跑」是唯一
 * 无法事后发现的错。
 * @param text `plan_json` 列的原文
 * @param fingerprint 随行登记的指纹（run 的 `plan_fingerprint` 或计划表的 `fingerprint`）
 * @param subject 句子主语，指认是谁的那份读数（如「库里这次 run」「计划 plan-1a2b」），界面原样显示
 * @param details 结构化上下文（runId / planId），进 `AppError.details` 供日志与卡片读
 * @returns 补全默认值并**重算过指纹**的计划本体
 * @throws `INVALID_ARGUMENT` 文本读不回、形状不合、或与登记的指纹不一致——绝不返回半条计划
 */
export function planFromStoredText(
  text: string,
  fingerprint: string,
  subject: string,
  details: Record<string, unknown>,
): WorkflowPlanView {
  let plan: WorkflowPlanView;
  try {
    plan = buildPlan(JSON.parse(text) as unknown);
  } catch (error) {
    throw new AppError(
      'INVALID_ARGUMENT',
      `${subject}的计划读数已损坏，无法读回：${error instanceof Error ? error.message : String(error)}`,
      'workflow.store',
      details,
    );
  }
  if (plan.fingerprint !== fingerprint) {
    throw new AppError('INVALID_ARGUMENT', `${subject}的计划与登记的指纹不一致，已拒绝读回`, 'workflow.store', {
      ...details,
      stored: fingerprint,
      recomputed: plan.fingerprint,
    });
  }
  return plan;
}

/**
 * BOSS 主线的第一条计划（spec 2.4-02/03/05 的验收对象）。
 *
 * 三个节点都是**线性**的，且第三个故意是「前两次必失败」的演示节点：
 * 断点续跑要看得见「从第 3 个节点继续」，重试退避要看得见「第 3 次才成功」，
 * 前两个真实节点因此只需承担「已完成不重放」的角色。
 * 执行器按 `kind` 从登记处取（见 `executors.ts`），本常量不含任何平台细节。
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
      // 计数放在本地 fixture 而不是进程内存：真 kill 之后重启仍要能看见「第 3 次才成功」
      // （spec 2.4-05 的验收要求进程死过一次，内存计数在那一刻会被清零，验收就拍不到这条路径）。
      params: { url: 'http://127.0.0.1:10233/api/fail-counter', failTimes: 2 },
      effect: 'local-write',
      retryTimes: 2,
    },
  ],
};

/**
 * 投递主线计划（spec 2.6-01 / 03 / 07 的节点路径）：两个连续的 `resume.deliver` 节点。
 *
 * 目标 id 用本地仿站的 1001 / 1002，是**刻意配的一对**：仿站对 1002 一律回「该岗位已下架」，
 * 于是同一次 run 里既有「确认之后递成功」的节点行（`status: done`），也有「页面说不再收」的
 * 节点行（`error: DELIVER_TARGET_OFFLINE`）——2.6-03 要的「失败不落账、结果状态在 `workflow_nodes`
 * 行里」和 2.6-07 要的「已下架不重试」由此一次取到，而不是靠 mock。
 * 两个节点都写 `file`？都不写：路径来自 `outbound.deliver` 配置的 `resumeFile`（P3 之前的临时入口），
 * 把某台机器上的绝对路径钉进仓库文件就是把演示数据当计划数据。
 */
export const BOSS_DELIVER_PLAN: PlanInput = {
  id: 'boss-deliver',
  nodes: [
    {
      id: 'deliver-1001',
      kind: 'resume.deliver',
      // target 参与幂等键 `runId+nodeId+target`：换目标就是换一件事，同目标重放才算重复。
      target: 'deliver://1001',
      params: { platform: 'boss', job: '1001' },
      // 副作用分级取 `outbound`：这一步会真的往页面上发东西，界面与 runner 都按这个级别播报。
      effect: 'outbound',
      // 0 次重试是 2.6-07「已下架就不再试」的落地口径——简历递不出去多半是页面不收，重放只是再撞一次。
      retryTimes: 0,
    },
    {
      id: 'deliver-1002',
      kind: 'resume.deliver',
      target: 'deliver://1002',
      params: { platform: 'boss', job: '1002' },
      effect: 'outbound',
      retryTimes: 0,
    },
  ],
};

/**
 * 全链路计划（spec 2.8-07 / M6 的验收对象）：搜索 → 读 JD → 生成话术并打招呼 →（定制简历·占位）→ 投递。
 *
 * 三条口径要写在这里，免得下一条读计划的人以为漏了节点：
 * ① **没有独立的「生成话术」节点**——`greeting.send` 不带 `text` 时用 `title`/`company` 现生成
 *    （`greet.ts:163` 调 `outbound.script.generate`，来源与模板版本一起写进账本 `source` 列），
 *    再开一只 `script.generate` 节点就是同一逻辑两处，而且节点之间没有传值通道，
 *    生成结果交给下一步也只会让它再生成一遍（plan §15.9 决策 1）；
 * ② 目标岗位取仿站的 **1001**：`/chat` 与 `/deliver` 都按 `targetId` 认它，`/api/jobs` 也能搜到它，
 *    所以打招呼与投递这两格外看到的是**同一个**岗位，链子不是拼出来的；
 * ③ `resume.deliver` 不带 `file` 参数：路径来自 `outbound.deliver` 配置的 `resumeFile`，
 *    与 `boss-deliver` 同一条理由——把某台机器上的绝对路径钉进仓库文件就是把演示数据当计划数据。
 */
export const BOSS_E2E_PLAN: PlanInput = {
  id: 'boss-e2e',
  nodes: [
    {
      id: 'e2e-capture',
      kind: 'jd.capture',
      // 关键词取仿站里真实存在的岗位名，链子后半的打招呼/投递才有同一个目标可对。
      params: { query: '前端工程师', city: '上海', target: 3 },
      effect: 'read',
    },
    {
      id: 'e2e-list',
      kind: 'jd.list',
      params: { limit: 5 },
      effect: 'read',
    },
    {
      id: 'e2e-greet',
      kind: 'greeting.send',
      target: 'greet://1001',
      // `title`/`company` 不给 `text`：这一步就要走生成那一路，界面与账本上才看得到话术来源。
      params: { platform: 'boss', job: '1001', title: '桌面端前端工程师（Electron）', company: '星桥科技' },
      effect: 'outbound',
      // 这句今天已经由 `retryBudgetFor` 兜住（外发步恒一次，spec 5.7-04），写在这里是为了读计划的人
      // 不必知道那条代码规则——声明与行为一致才有可读的计划。
      retryTimes: 0,
    },
    {
      id: 'e2e-customize',
      kind: 'resume.customize',
      target: 'resume://1001',
      params: { platform: 'boss', job: '1001' },
      // 只读：占位格一个字节都不改，也不外发（真做定制属 P3，plan §15.9 决策 2）。
      effect: 'read',
    },
    {
      id: 'e2e-deliver',
      kind: 'resume.deliver',
      target: 'deliver://1001',
      params: { platform: 'boss', job: '1001', title: '桌面端前端工程师（Electron）', company: '星桥科技' },
      effect: 'outbound',
      // 同 boss-deliver：投递失败多半是页面不收，重放只是再撞一次（spec 2.6-07）。
      retryTimes: 0,
    },
  ],
};

/**
 * P2 的内置计划清单：`planId` → 声明。
 *
 * `boss-basic` 是 2.4 的「顺序推进 / 失败重试 / 断点续跑」主线，`boss-deliver` 是 2.6 的投递主线
 * （节点路径要能落到库里那两张表，才取得到 `workflow_nodes.error` 这类读数），
 * `boss-e2e` 是 2.8-07 / M6 的全链路收口：从搜索一直走到投递，中间每一步都是真的能力而不是演示节点。
 * 配置键 `planId` 从这张表里选一条，选不到就装配期失败。
 */
export const WORKFLOW_PLANS: Readonly<Record<string, PlanInput>> = {
  'boss-basic': BOSS_BASIC_PLAN,
  'boss-deliver': BOSS_DELIVER_PLAN,
  'boss-e2e': BOSS_E2E_PLAN,
};

/**
 * 按 id 取计划。
 * @param id 配置键 `planId` 的值
 * @returns 补全默认值并算好指纹的计划视图
 * @throws 表里没有这个 id 时以 `INVALID_ARGUMENT` 失败并列出可用 id——
 *         「配置写错了一个字母」必须一眼能看出来，而不是表现为工作流起不来
 */
export function planById(id: string): WorkflowPlanView {
  const input = WORKFLOW_PLANS[id];
  if (!input) {
    const available = Object.keys(WORKFLOW_PLANS);
    throw new AppError('INVALID_ARGUMENT', `未知的工作流计划 ${id}，可选：${available.join('、')}`, 'workflow.plan', {
      planId: id,
      available,
    });
  }
  return buildPlan(input);
}
