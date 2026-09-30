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
 */
import { AppError, maybeService, Service, type Context, type WorkflowNodeSpec } from '@auto-cc/core';
import { z } from 'zod';

/**
 * 一次节点执行的输入。
 * 执行器**不**拿到 runner 的内部态：它能读到的就是计划声明 + 第几次尝试 + 让出信号，
 * 于是「暂停时正在跑的那一步能自己收手」是协作式的（spec 1.10-05 / 2.4-07）。
 */
export type WorkflowNodeInvocation = {
  /** 本次 run 的 id，用于把外部动作与库里的行对上。 */
  runId: string;
  /** 计划里的节点声明（含参数）。 */
  spec: WorkflowNodeSpec;
  /** 第几次尝试，含首次，从 1 起；上限是 `1 + retryTimes`（spec 2.4-03）。 */
  attempt: number;
  /** 协作让出信号：暂停/卸载时它是 aborted，长任务必须在中途检查它。 */
  signal: AbortSignal;
};

/** 一个节点的执行函数；失败就抛，runner 据此走退避或判失败。 */
export type WorkflowNodeExecutor = (invocation: WorkflowNodeInvocation) => Promise<void>;

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

export class WorkflowExecutorRegistryService extends Service {
  static provide = 'workflow.executors';
  static Config = executorRegistrySchema;

  constructor(ctx: Context, _options: ExecutorRegistryConfig) {
    super(ctx, 'workflow.executors');
  }

  /** kind → 执行函数。 */
  private readonly table = new Map<string, WorkflowNodeExecutor>();

  /**
   * 登记一个执行器。
   * @param kind 节点声明里的执行器名（约定 `域.能力`，如 `jd.capture`）
   * @param executor 执行函数
   * @returns 无；重复登记同名 kind 会**覆盖**并被记一笔（见文件头：被重启的一侧要能拿回自己的节点）
   */
  register = (kind: string, executor: WorkflowNodeExecutor): void => {
    if (this.table.has(kind)) this.ctx.logger.info(`执行器 ${kind} 被重新登记，以最后一次为准`);
    this.table.set(kind, executor);
  };

  /**
   * 注销某个 `kind` 的执行器（能力包被卸载时调用，避免留下指向已销毁实例的函数）。
   * @param kind 执行器名
   * @returns 是否真的删掉了一条登记
   */
  unregister = (kind: string): boolean => this.table.delete(kind);

  /**
   * 查一个执行器。
   * @param kind 执行器名
   * @returns 已登记的执行函数；没登记过则为 null（由调用方判「这条计划现在跑不了」）
   */
  resolve = (kind: string): WorkflowNodeExecutor | null => this.table.get(kind) ?? null;

  /**
   * 当前登记了哪些执行器（诊断面板读它，用来回答「这条计划能不能跑」）。
   * @returns 按登记顺序的执行器名列表
   */
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

/**
 * 把可选服务能力包在本包里用到的那一只手取出来。
 *
 * 各能力包在自己的服务里这样调登记处，是为了**不把 `plugin-workflow` 变成运行期依赖**：
 * 工作流没装时节点只是没人能跑，抓取本身不该跟着启动失败。
 * @param ctx 调用方的上下文
 * @returns 登记处实例；未挂载为 undefined
 */
export function executorRegistryOf(ctx: Context): WorkflowExecutorRegistryService | undefined {
  return maybeService<WorkflowExecutorRegistryService>(ctx, 'workflow.executors');
}
