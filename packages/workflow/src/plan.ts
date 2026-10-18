/**
 * 工作流计划的**声明层**（spec 2.4-01）：节点是什么、一条计划怎么序列化成库里的文本。
 *
 * 刻意与执行器解耦：`kind` 只是执行器的名字，runner 按它分派，计划本身不认识任何平台、
 * 也不含任何选择器或 URL。于是 2.4-08 的「mock 适配器跑完整条链」不需要改计划，
 * 而 P5 想加一条「只做择机投递」的计划也只是多一个数据文件。
 */
import { AppError, TOOL_EFFECTS, type WorkflowNodeSpec, type WorkflowPlanView } from '@auto-cc/core';
import { z } from 'zod';
import { graphFingerprint } from './canonical.js';
import { provesLandedEffect } from './terminal-state.js';

/** 节点参数值：计划要能整体 JSON 序列化进库，所以不接受嵌套对象（嵌套就得再设计一层模板引擎）。 */
const nodeParamSchema = z.union([z.string(), z.number(), z.boolean()]);

/**
 * 浏览器节点族的 kind 前缀（spec 5.12-06）。
 *
 * 认前缀而不是认某个具体 kind：这一族往后还要长 `browser.select` / `browser.waitFor` 那几格，
 * 而「外发型必须自带成功判据」是**整族**的性质。判定放在这一层是因为这里是唯一同时看得见
 * 整份计划与节点 `effect` 的地方，而 `provesLandedEffect` 也在本包里——浏览器包（L2）不许
 * 反向依赖本包（L3），所以这条检查只能在这侧。
 */
const BROWSER_NODE_KIND_PREFIX = 'browser.';

/**
 * 一条判据的声明形状（spec 5.11-03）。
 *
 * 三个字段各自只对一种 kind 有意义，所以用 `superRefine` 而不是三个互斥 schema：
 * 一条判据只有三键，拆成三个联合分支换来的只是更长的报错文本。
 * 「值对不对 kind」由 `buildPlan` 统一拒（那里才知道计划里有哪些格子）。
 */
const workflowConditionSchema = z.strictObject({
  kind: z.enum(['effectObserved', 'nodeCommitted', 'urlContains']),
  value: z.string().optional(),
  nodeId: z.string().min(1).optional(),
});

/**
 * 定位候选的**形状**校验（spec 5.12-02）。
 *
 * 只管形状，不管语义：策略与该策略所需字段对不对得上、属性名合不合法，那些是
 * `packages/browser/src/locator-spec.ts` 的 `validateSpec` 在**执行前**做的事。
 * 装配期这一层存在的意义只有一件——让一份写错的计划在跑之前就被拒，而不是跑到那一格才炸。
 */
const locateCandidateSchema = z.strictObject({
  strategy: z.enum(['testId', 'id', 'name', 'role', 'text', 'css', 'xpath', 'fingerprint']),
  value: z.string().optional(),
  attribute: z.string().optional(),
  role: z.string().optional(),
  name: z.string().optional(),
  exact: z.boolean().optional(),
});

/**
 * 节点声明里那一格定位（spec 5.12-02）：`LocateSpec` 去掉 `effect` 的投影。
 *
 * 这里**没有** `effect` 这一位，而 core 那个 `WorkflowNodeLocate` 类型也没有——
 * 通道由节点的 `effect` 派生（plan §7.10.1 子决定 b）。用 `strictObject` 是刻意的：
 * 计划里多写一个 `effect` 就该被拒，否则「节点自称 `read` 而通道按 `outbound` 算」
 * 这种错配会以"读起来没问题"的样子留在库里。
 */
const nodeLocateSchema = z.strictObject({
  description: z.string(),
  cardinality: z.enum(['single', 'many']),
  candidates: z.array(locateCandidateSchema).min(1),
  requireActionable: z.boolean().optional(),
});

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
  /**
   * 本节点声明的出口名（5.10-b 起，spec 5.10-02）。省略 = 只有 `default` 出口，
   * 也就是 2.4 那三条线性计划的写法；**线性计划不需要逐个补写**。
   */
  outputs: z.array(z.string().min(1)).min(1).optional(),
  /**
   * 成功判据（5.11-03）：与终态判据分列两个字段，不许合成一个。
   * 每一行都必须能证明落地效果，形状对但证明不了的那一类在 `buildPlan` 里被拒。
   */
  successConditions: z.array(workflowConditionSchema).min(1).optional(),
  /** 终态判据（5.11-03）：派执行器之前先问一遍，全成立就不重放这一格。 */
  terminalStateConditions: z.array(workflowConditionSchema).min(1).optional(),
  /**
   * 这一格要定位的东西（spec 5.12-02）。只在 `browser.*` 那一族上出现，其余 kind 省略。
   * 省略即「不定位页面元素」，所以既有计划一个字节都不变。
   */
  locate: nodeLocateSchema.optional(),
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
 * 算一条计划的指纹（2.4-01 的「可序列化」与 plan §11.3 的「续跑前校验指纹」共用一处实现）。
 *
 * 哈希原语与口径整体搬到 `canonical.ts`：那里还服务 5.10-b 的图读数，而计划与它的线性投影
 * **必须**算出同一个值（否则同一份语义两条真相，5.10-07 的续跑判据就空了）。
 * @param nodes 补全默认值之后的节点数组
 * @returns 8 位十六进制指纹；只与执行语义有关，与计划 id 无关
 */
function planFingerprint(nodes: readonly WorkflowNodeSpec[]): string {
  return graphFingerprint(nodes);
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
  assertConditionsUsable(parsed.data.nodes, seen);
  // `params` 的默认值必须在这里补全：落库和界面读到的都应当是补全后的形状，而不是「有时有 key 有时没有」。
  // `outputs` 反过来**不补默认值**：省略就是"只有 default 出口"的读法，由投影方（`graph.ts`）按同一口径解释，
  // 这样 2.4 时代留下的计划文本一个字节都不变，历史 run 的续跑判据也不会被 5.10-b 动到。
  // 两个判据字段同理不补默认值：省略就是「没有判据」的读法，而补一个空数组会让 5.11 的两列都变成必填。
  // `locate` 走同一条路（spec 5.12-03）：省略就是「这一格不定位」，补一个空壳则会让每一格都自称定位过。
  const nodes: WorkflowNodeSpec[] = parsed.data.nodes.map((node) => ({
    id: node.id,
    kind: node.kind,
    target: node.target,
    params: node.params,
    effect: node.effect,
    retryTimes: node.retryTimes,
    requiresHuman: node.requiresHuman,
    ...(node.outputs === undefined ? {} : { outputs: node.outputs }),
    ...(node.successConditions === undefined ? {} : { successConditions: node.successConditions }),
    ...(node.terminalStateConditions === undefined ? {} : { terminalStateConditions: node.terminalStateConditions }),
    ...(node.locate === undefined ? {} : { locate: node.locate }),
  }));
  return { id: parsed.data.id, nodes, fingerprint: planFingerprint(nodes) };
}

/**
 * 逐条核判据声明（spec 5.11-03 / 5.11-04）。
 *
 * 三件事在这里拒，因为只有这一处同时看得见「整份计划」与「节点的 kind」：
 * ① 成功判据里出现**证明不了落地效果**的那一行（模型写的 `urlContains /publish/` 是现场原话）——
 *    留着它等于宣布「这一格的成功可以被一行证明不了的读数认证」；
 * ② `nodeCommitted` 指名一个计划里没有的格子——那种判据永远观测不到，等于把跳过写成哑条件；
 * ③ `nodeCommitted` 指名自己——自己没落定时读自己恒为 false，是一条永远不成立的死判据。
 *
 * ④ 外发型 `browser.*` 格子没有成功判据（spec 5.12-06）。这一条只对这一族成立，不是全家的规矩：
 * `greeting.send` / `resume.deliver` 那两条既有计划一条判据都没声明，泛起来就等于改既有计划的读法。
 * 而这一族非要有不可的理由来自 8.4-05 的实测——`browser.act` 在点击落到视口之外时**照样回成功**，
 * 所以「动作通道回了成功」这一句读数证明不了任何落地效果，这一格只有判据能证明它成了。
 * @param nodes 已过 schema 的节点声明
 * @param knownNodeIds 计划内的节点 id 集合
 * @returns 无；不合即抛 `TypeError`（与本文件其它形状错误同一种失败面）
 */
function assertConditionsUsable(
  nodes: readonly z.output<typeof workflowNodeSpecSchema>[],
  knownNodeIds: ReadonlySet<string>,
): void {
  for (const node of nodes) {
    if (
      node.effect === 'outbound' &&
      node.kind.startsWith(BROWSER_NODE_KIND_PREFIX) &&
      !node.successConditions?.length
    ) {
      throw new TypeError(`节点 ${node.id} 是外发型浏览器格子却没有成功判据：动作通道回成功不等于落地（spec 8.4-05）`);
    }
    for (const condition of node.successConditions ?? []) {
      if (!provesLandedEffect(condition)) {
        throw new TypeError(
          `节点 ${node.id} 的成功判据里有一行证明不了落地效果（${condition.kind}）：地址栏只说明 run 在哪，不说明它做了什么`,
        );
      }
    }
    for (const condition of node.terminalStateConditions ?? []) {
      if (condition.kind !== 'nodeCommitted') continue;
      const named = condition.nodeId ?? '';
      if (!knownNodeIds.has(named)) {
        throw new TypeError(`节点 ${node.id} 的终态判据指名了计划里没有的格子 ${named}`);
      }
      if (named === node.id) {
        throw new TypeError(`节点 ${node.id} 的终态判据指名了自己，这一格没落定时读自己恒为假`);
      }
    }
  }
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
