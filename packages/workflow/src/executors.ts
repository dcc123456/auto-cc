/**
 * `workflow.executors` 服务（spec 2.4-01 / 2.4-08）：节点 `kind` → 执行函数的登记表。
 *
 * 为什么必须有这一层：plan §3 规则 2 要求「workflow 不认识平台包」，而 `boss-basic` 计划的
 * `jd-capture` 节点又确实要调 JD 抓取。于是执行器**由有能力的那一侧登记进来**（与各平台包
 * 把自己登记进 `platform.registry` 同一个手法），runner 只按 `kind` 查表。
 * 2.4-08 的「用 mock 跑完整条链」因此不需要动 runner：测试登记三个假函数就够了。
 *
 * 登记是「最后写入者说话」而不是拒绝重复：插件可以被单独重启（1.5），若第二次登记就报错，
 * 被重启的那一侧将永远拿不回自己的节点。
 *
 * 契约形状（`WorkflowNodeInvocation` / `WorkflowNodeExecutor` / `WorkflowExecutorRegistry`）在
 * `@auto-cc/core`：登记由各能力包（L2）发起，而下层不能 import 上层（AGENTS.md §4.1），
 * 所以这一层只放**实现**与 `demo.flaky`。取登记处用 `core` 的 `executorRegistryOf`。
 */
import {
  AppError,
  Service,
  type Context,
  type WorkflowExecutorRegistry,
  type WorkflowNodeExecutor,
} from '@auto-cc/core';
import { z } from 'zod';

/** 登记形状：无配置项，但构造器仍要接住 cordis 递来的第二个实参（AGENTS.md §9 的 1.3 实测条）。 */
export const executorRegistrySchema = z.strictObject({});

/** 校验后的配置形状。 */
export type ExecutorRegistryConfig = z.infer<typeof executorRegistrySchema>;

/**
 * 内置的失败注入执行器（spec 2.4-03 / 2.4-05 / 2.4-06 的靶子）。
 *
 * 它是全仓唯一一个不碰任何平台包的节点实现，因为它的用途就是「可控地失败若干次」：
 * 打一个本地 fixture 计数器，命中次数不超过 `failTimes` 就抛。计数放在 app 外部，
 * 所以真 kill 之后重启也能看见「第 3 次才成功」这条完整的路（2.4-05 的截图才有内容可拍）。
 * @param invocation 节点执行输入，参数取 `url`（fixture 计数端点）与 `failTimes`
 * @throws 缺 `url` 时 `INVALID_ARGUMENT`；命中次数在 `failTimes` 以内时 `WORKFLOW_STEP_FAILED`；
 *         端点非 2xx 时 `WORKFLOW_STEP_FAILED`（附带状态码）
 */
const flakyExecutor: WorkflowNodeExecutor = async ({ spec, attempt, signal }) => {
  const url = spec.params.url;
  if (typeof url !== 'string' || url === '') {
    throw new AppError('INVALID_ARGUMENT', `节点 ${spec.id} 缺少参数 url，无法调用失败计数器`, 'workflow.executors', {
      nodeId: spec.id,
    });
  }
  const failTimes = typeof spec.params.failTimes === 'number' ? spec.params.failTimes : 0;
  const response = await fetch(url, { method: 'POST', signal });
  if (!response.ok) {
    throw new AppError('WORKFLOW_STEP_FAILED', `失败计数端点返回 ${String(response.status)}`, 'workflow.executors', {
      nodeId: spec.id,
      url,
    });
  }
  const body = (await response.json()) as { hits?: number };
  const hits = typeof body.hits === 'number' ? body.hits : attempt;
  if (hits <= failTimes) {
    throw new AppError(
      'WORKFLOW_STEP_FAILED',
      `第 ${String(hits)} 次命中，按注入计划失败（failTimes=${String(failTimes)}）`,
      'workflow.executors',
      { nodeId: spec.id, hits, failTimes },
    );
  }
};

/** `demo.flaky` 的 kind 名，写在一处以免计划常量与登记表各说一份。 */
export const DEMO_FLAKY_KIND = 'demo.flaky';

export class WorkflowExecutorRegistryService extends Service implements WorkflowExecutorRegistry {
  static provide = 'workflow.executors';
  static Config = executorRegistrySchema;

  constructor(ctx: Context, _options: ExecutorRegistryConfig) {
    super(ctx, 'workflow.executors');
  }

  /** kind → 执行函数。 */
  private readonly table = new Map<string, WorkflowNodeExecutor>();

  /** 契约见 `WorkflowExecutorRegistry.register`；重复登记会覆盖并记一笔。 */
  register = (kind: string, executor: WorkflowNodeExecutor): void => {
    if (this.table.has(kind)) this.ctx.logger.info(`执行器 ${kind} 被重新登记，以最后一次为准`);
    this.table.set(kind, executor);
  };

  /** 契约见 `WorkflowExecutorRegistry.unregister`。 */
  unregister = (kind: string): boolean => this.table.delete(kind);

  /** 契约见 `WorkflowExecutorRegistry.resolve`。 */
  resolve = (kind: string): WorkflowNodeExecutor | null => this.table.get(kind) ?? null;

  /** 契约见 `WorkflowExecutorRegistry.list`。 */
  list = (): string[] => [...this.table.keys()];

  [Service.init](): void {
    // 失败注入器随登记表一起就位：它不属于任何能力包，也就没有别的时机可挂。
    this.register(DEMO_FLAKY_KIND, flakyExecutor);
    this.ctx.logger.info(`执行器登记处就绪：内置 ${DEMO_FLAKY_KIND}，其余由各能力包自行登记`);
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'workflow.executors': WorkflowExecutorRegistryService;
  }
}
