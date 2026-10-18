/**
 * `browser.*` 节点族（spec 5.12-04 / 05 / 06）：把「点这个按钮」做成一条计划里的格子。
 *
 * 这一族**不是**第二套浏览器能力，它只是既有 `browser.act` / `browser.page` 的编排层：
 * 执行器只做三件事——把节点声明组装成 `LocateSpec`、挑出动作通道、按 `effect` 该过的门过一遍。
 * 判分与阈值仍在 `decideLocate` 独家（`locator-spec.ts`），本文件里一个分数都不算。
 *
 * 两条硬约束写在代码形状里而不是注释里（plan §7.10.1 第四节）：
 * - **不新增第二套外发通路**：`effect: 'outbound'` 的格子，动作在 `gate.perform` 的 task 里派发，
 *   而 `perform` 判定不过就根本不调 task（`gate.ts:141-143`）——于是「额度不足时页面一个字节都没动」
 *   是结构保证，不靠谁记得先查一遍。`browser.act` 自身**不过闸门**（它是「把指针挪过去」的能力），
 *   所以这道门只能由调用方给，而工作流是第一条会让绕闸变容易的通道。
 * - **不复制定位判定**：节点只声明候选，判定那一行代码在这里不存在。
 *
 * 另一条来自 8.4-05 的实测：`browser.act` 在点击落到视口之外时**照样回成功**，所以
 * `act` 的返回值不能充当这一格的成功判据。外发型格子必须自带一条能证明落地效果的
 * `successConditions`（装配期由 `packages/workflow` 的 `assertConditionsUsable` 查证明力），
 * 这里再查一次「有没有」，是为了挡住手改库 JSON 绕过装配期的那条路。
 */
import {
  AppError,
  Service,
  asApp,
  executorRegistryOf,
  maybeService,
  type Context,
  type WorkflowNodeInvocation,
  type WorkflowNodeSpec,
} from '@auto-cc/core';
import { QUOTA_ACTIONS, type LocateSpec, type QuotaAction } from '@auto-cc/shared';
import { z } from 'zod';

/** 导航：把内核视图开到一处已登记平台的地址上。参数是 `url`。 */
export const BROWSER_NAVIGATE_KIND = 'browser.navigate';
/** 点击：按定位声明点一个元素。 */
export const BROWSER_CLICK_KIND = 'browser.click';
/** 输入：往定位声明指的控件里写一段文本，参数是 `text`。 */
export const BROWSER_TYPE_KIND = 'browser.type';

/** 本文件登记的三种 kind，诊断面板读它来回答「这一格有没有手」。 */
export const BROWSER_NODE_KINDS = [BROWSER_NAVIGATE_KIND, BROWSER_CLICK_KIND, BROWSER_TYPE_KIND] as const;

/**
 * 闸门的那一只手（spec 5.12-05）。
 *
 * 刻意写成结构类型而不是 import `plugin-entitlement` 的类型：`packages/entitlement` 与本包
 * 同级，横向往来是 AGENTS.md §4.1 禁的。`packages/agent/src/session.ts` 取闸门时用的是同一手写法。
 */
type GateHand = {
  perform: <T>(
    action: QuotaAction,
    context: { targetId?: string; workflowRunId?: string; nowMs?: number },
    task: () => Promise<T>,
  ) => Promise<{ value: T; ledgerId: number | string }>;
};

/**
 * 节点上的定位声明组装成 `LocateSpec`（spec 5.12-02 的派生那一步）。
 *
 * **通道由节点的 `effect` 派生**，不由节点自己声明——`LocateSpec.effect` 那一位在
 * `WorkflowNodeLocate` 这个 `Pick` 里根本不存在（plan §7.10.1 子决定 b），所以「一个节点自称
 * `read` 而阈值按 `outbound` 算」这种错配在类型层就写不出来。
 * @param spec 节点声明
 * @returns 交给 `browser.act` 的定位声明；`effect` 一律落在最严的那一档（`outbound`）除非节点是只读
 * @throws 节点没声明定位，或声明形状对而必填项缺失时以 `INVALID_ARGUMENT` 结构化失败
 */
function locateSpecOf(spec: WorkflowNodeSpec): LocateSpec {
  const locate = spec.locate;
  if (!locate) {
    throw new AppError(
      'INVALID_ARGUMENT',
      `节点 ${spec.id}（${spec.kind}）没有声明要定位的东西，无法定位元素`,
      spec.kind,
      { nodeId: spec.id },
    );
  }
  return {
    description: locate.description,
    cardinality: locate.cardinality,
    candidates: locate.candidates,
    ...(locate.requireActionable === undefined ? {} : { requireActionable: locate.requireActionable }),
    effect: spec.effect === 'read' ? 'read' : 'outbound',
  };
}

/**
 * 这一格要记到账本上的目标键。
 *
 * 幂等键用的是 `runId + nodeId + target`，而只读格子允许 `target` 为空串，于是这里退回节点 id：
 * 账本要能回答「这一格花掉了一条额度」，而空串回答不了任何一格是哪一格。
 * @param spec 节点声明
 * @returns 目标键
 */
function quotaTargetOf(spec: WorkflowNodeSpec): string {
  return spec.target === '' ? spec.id : spec.target;
}

/**
 * 读节点声明里的一个字符串参数。
 * @param spec 节点声明
 * @param key 参数名
 * @param purpose 参数用途（拼进报错文案，让人知道缺的是哪一样）
 * @returns 非空字符串
 * @throws 缺参数、参数不是字符串或为空串时以 `INVALID_ARGUMENT` 结构化失败
 */
function requiredParam(spec: WorkflowNodeSpec, key: string, purpose: string): string {
  const value = spec.params[key];
  if (typeof value !== 'string' || value === '') {
    throw new AppError('INVALID_ARGUMENT', `节点 ${spec.id}（${spec.kind}）缺少参数 ${key}，${purpose}`, spec.kind, {
      nodeId: spec.id,
      param: key,
    });
  }
  return value;
}

/**
 * 外发型格子在动手之前要过的两道自查。
 *
 * ① **额度动作名必填且取自 `QUOTA_ACTIONS`**：就 `search｜greet｜deliver` 三个名字，
 *    自造一个就会出现「界面能发明一个闸门没有的动作名」（`bridge.ts` 的 `QUOTA_ACTIONS` 注释原话）。
 * ② **成功判据必填**：`browser.act` 回成功不等于动作落地（8.4-05：视口外的点击照样回成功），
 *    没有判据这一格就永远只有「点过了」这半句读数。注意这里查的是**有没有**，
 *    「证明不证明得成立」是装配期 `assertConditionsUsable` 的活，两处不重叠。
 * @param spec 节点声明
 * @param gate 闸门（可能没挂载）
 * @throws 任一条不成立时以 `INVALID_ARGUMENT` / `SERVICE_NOT_FOUND` 结构化失败，动作一个都不派发
 */
function assertOutboundReady(spec: WorkflowNodeSpec, gate: GateHand | undefined): QuotaAction {
  if (!gate) {
    throw new AppError(
      'SERVICE_NOT_FOUND',
      `节点 ${spec.id} 是外发型而闸门没挂载，拒绝动手（没有闸门的外发等于没有外发）`,
      spec.kind,
      { nodeId: spec.id },
    );
  }
  const quota = requiredParam(spec, 'quota', '不知道这一格要记到哪一条额度上');
  if (!(QUOTA_ACTIONS as readonly string[]).includes(quota)) {
    throw new AppError(
      'INVALID_ARGUMENT',
      `节点 ${spec.id} 的参数 quota 是 ${quota}，闸门只认 ${QUOTA_ACTIONS.join(' / ')}`,
      spec.kind,
      { nodeId: spec.id, quota },
    );
  }
  const proofs = spec.successConditions ?? [];
  if (proofs.length === 0) {
    throw new AppError(
      'INVALID_ARGUMENT',
      `节点 ${spec.id} 是外发型却没有成功判据，拒绝动手（动作回成功不等于落地，spec 8.4-05）`,
      spec.kind,
      { nodeId: spec.id },
    );
  }
  return quota as QuotaAction;
}

/** 登记形状：无配置项，但构造器仍要接住 cordis 递来的第二个实参（AGENTS.md §9 的 1.3 实测条）。 */
const browserNodeSchema = z.strictObject({});

/** 校验后的配置形状。 */
export type BrowserNodeConfig = z.infer<typeof browserNodeSchema>;

/**
 * `browser.*` 节点执行器宿主（spec 5.12-04）。
 *
 * 装配期只做一件事：把这三种 kind 交给 `workflow.executors`。它对工作流包**没有**硬依赖
 * （登记处缺席时只是这三种格子没有手，`browser.act` 与界面照常可用），这与 `jd.capture`
 * 同一口径。清单里的挂载位置必须排在 `workflow-executors` 之后——cordis 的 `ctx.get`
 * 对未 ACTIVE 的 fiber 返回 undefined（`cordis/lib/index.js:1142`），排早了登记会静默落空。
 */
export class BrowserNodeService extends Service {
  static provide = 'browser-nodes';
  static Config = browserNodeSchema;
  static inject = ['browser.act', 'browser.page'];

  constructor(ctx: Context, _options: BrowserNodeConfig) {
    super(ctx, 'browser-nodes');
  }

  [Service.init](): void {
    const registry = executorRegistryOf(this.ctx);
    if (!registry) return;
    for (const kind of BROWSER_NODE_KINDS) {
      registry.register(kind, kind === BROWSER_NAVIGATE_KIND ? this.navigateNode : this.elementNode(kind));
    }
    this.ctx.effect(() => () => {
      for (const kind of BROWSER_NODE_KINDS) registry.unregister(kind);
    });
  }

  /**
   * 导航执行器：把内核视图开到 `params.url`，其余声明（定位、判据）这一格用不上。
   * @param invocation 节点执行输入
   * @returns 无
   * @throws 缺 `url` 时 `INVALID_ARGUMENT`；地址被许可判定拒绝时沿用 `browser.page` 的码
   */
  navigateNode = async (invocation: WorkflowNodeInvocation): Promise<void> => {
    const url = requiredParam(invocation.spec, 'url', '不知道要开哪一页');
    await asApp(this.ctx)['browser.page'].navigate(url);
  };

  /**
   * 点击与输入共用的执行器骨架：定位 → （外发型则过闸门）→ 动作。
   *
   * 只读格子直接派动作；外发型把派发放进 `gate.perform` 的 task 里，于是额度不足、闸门没挂载、
   * 动作名没声明这三种情况**都发生在动作被派发之前**。
   * @param kind 这个执行器登记的 kind（报错文案与源标识用）
   * @returns 可登记进 `workflow.executors` 的执行函数
   */
  private elementNode(kind: string) {
    return async (invocation: WorkflowNodeInvocation): Promise<void> => {
      const { spec, runId, signal } = invocation;
      const act = asApp(this.ctx)['browser.act'];
      const dispatch = async (): Promise<void> => {
        assertNotAborted(signal, kind, spec.id);
        if (kind === BROWSER_CLICK_KIND) {
          await act.click(locateSpecOf(spec));
          return;
        }
        await act.type(locateSpecOf(spec), requiredParam(spec, 'text', '不知道要往里写什么'));
      };
      if (spec.effect !== 'outbound') {
        // 只读格子却带着额度参数：这一格不过闸门也不落账，而读声明的人会以为它过过闸门。
        // 这种误认比多一道检查贵，所以宁可拒，也不让一个没被记账的额度参数混过去。
        if (spec.params.quota !== undefined) {
          throw new AppError(
            'INVALID_ARGUMENT',
            `节点 ${spec.id} 声明只读（effect: 'read'）却带着 quota 参数，它不过闸门也不落账`,
            kind,
            { nodeId: spec.id },
          );
        }
        await dispatch();
        return;
      }
      const gate = maybeService<GateHand>(this.ctx, 'entitlement.gate');
      const quota = assertOutboundReady(spec, gate);
      await (gate as GateHand).perform(quota, { targetId: quotaTargetOf(spec), workflowRunId: runId }, dispatch);
    };
  }
}

/**
 * 让出检查点：暂停不是失败，所以这里返回而不是抛。
 * @param signal 节点执行输入里的协作信号
 * @param kind 执行器名（报错文案用）
 * @param nodeId 节点 id（报错文案用）
 * @throws 已被暂停时抛错——动作还没派发，抛错才是诚实读数
 */
function assertNotAborted(signal: AbortSignal, kind: string, nodeId: string): void {
  if (signal.aborted) {
    throw new AppError('WORKFLOW_STEP_FAILED', `节点 ${nodeId} 在动手之前就被暂停了`, kind, { nodeId });
  }
}
