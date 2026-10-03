/**
 * 外发层用例的替身（`greet.test.ts` / `deliver.test.ts` 共用）。
 *
 * 只替一只手：`FakeSessionsService` 替「风险确认的签字记录」。真身在 L2 会话层且 `inject` 了
 * Electron 外壳（`shell`），在 Node 侧的用例里挂不起来；而这两份用例要验收的是
 * 「没签过字就一步都不许走」这条**判定顺序**，所以签字表必须能被用例拨到「没签」那一侧，
 * 闸门 / 账本 / 频控 / 话术一律用真实服务——把账本 mock 掉就等于没测「被拦下时没扣额度」。
 */
import {
  AppError,
  type AgentToolDeclaration,
  type AgentToolRegistry,
  type ConsentGate,
  type Context,
  type JdKeySource,
  type JdReplyStatusSource,
  Service,
  type ToolEffect,
  type ToolResult,
} from '@auto-cc/core';
import { z } from 'zod';

/** 替身的配置形状：无键，但构造器仍要接住 cordis 递来的第二个实参。 */
const fakeSessionsSchema = z.strictObject({});

/**
 * 假的 `sessions`：只回答「这个平台签过自动化风险确认吗」。
 *
 * 存在理由：`outbound.greet` / `outbound.deliver` 从 2.7-e 起把 `sessions` 列为硬依赖
 * （`consentGateOf` 读不到就抛），装配清单里没有它这两条链路整条停在 PENDING。
 * 签字表做成可增删的，用来演「第一次点确认之前，释放路径必须一步都不走」。
 */
export class FakeSessionsService extends Service implements ConsentGate {
  static provide = 'sessions';
  static Config = fakeSessionsSchema;

  /** 已签字的平台标识；真实实现把它放在 sqlite 里，这里只需要「签过 / 没签过」。 */
  private readonly granted = new Set<string>();

  /** 被问了多少次（spec 2.7-06 的读数：一次外发只该问一次，问出两次说明编排层在重复判定）。 */
  asks = 0;

  constructor(ctx: Context, _options: Record<string, never>) {
    super(ctx, 'sessions');
  }

  /**
   * 往签字表里写一个平台（真实现里这一步是用户在确认卡片上点「我承担」）。
   * @param platform 平台标识
   */
  grant(platform: string): void {
    this.granted.add(platform);
  }

  /**
   * 从签字表里抹掉一个平台（演「换一台机器 / 库还没签过」）。
   * @param platform 平台标识
   */
  revoke(platform: string): void {
    this.granted.delete(platform);
  }

  /** 契约见 `ConsentGate.hasConsent`。 */
  hasConsent = (platform: string): boolean => {
    this.asks += 1;
    return this.granted.has(platform);
  };

  /**
   * 契约见 `ConsentGate.ensureConsent`：未签即抛 `CONSENT_REQUIRED`。
   *
   * 真身还会先校验平台登记过没有（未登记抛 `PLATFORM_NOT_CONFIGURED`），这一支替身不建模：
   * 用例里的平台名都是登记过的，未登记那一条由界面侧的实测覆盖。
   */
  ensureConsent = (platform: string): void => {
    if (this.hasConsent(platform)) return;
    throw new AppError('CONSENT_REQUIRED', `平台 ${platform} 还没有一份自动化风险确认记录`, 'sessions', { platform });
  };
}

/**
 * 假的 `agent.tools`：只做「往里放、往外摘」这两只手（spec 2.8-08 的登记表替身）。
 *
 * 不复用真 `AgentToolsService` 的原因是依赖方向：注册表属于 L3 对话插件，本包（L2）连测试都不该
 * import 它，而跨包共享一个测试替身要新建一个包（§4.3 得先在 plan 里记理由）。三个 L2 包各留一份
 * 这样的薄替身，与 `FakeSessionsService` 在 browser / outbound 各有一份是同一条先例。
 * 它只替「登记处」，闸门 / 账本 / 频控 / 话术仍然全是真身——否则 2.8-10 的「被 gate 判定且记账」就没测到。
 */
export class FakeAgentToolsService extends Service implements AgentToolRegistry {
  static provide = 'agent.tools';
  static Config = z.strictObject({});

  /** 收到的声明，`Map` 的迭代序即登记顺序。 */
  readonly declarations = new Map<string, AgentToolDeclaration>();

  /** 被摘回的 id，按摘除顺序（销毁那条用例的读数）。 */
  readonly removed: string[] = [];

  constructor(ctx: Context) {
    super(ctx, 'agent.tools');
  }

  /** 契约见 `AgentToolRegistry.register`。 */
  register<I>(tool: AgentToolDeclaration<I>): void {
    this.declarations.set(tool.id, tool);
  }

  /** 契约见 `AgentToolRegistry.unregister`。 */
  unregister(id: string): boolean {
    this.removed.push(id);
    return this.declarations.delete(id);
  }

  /**
   * 清单读数：id + 副作用分级 + 批准位，正是 2.8-08 判据要逐条核对的三样。
   * @returns 按登记顺序排列的元数据
   */
  list(): { id: string; effect: ToolEffect; requiresConfirmation: boolean }[] {
    return [...this.declarations.values()].map((tool) => ({
      id: tool.id,
      effect: tool.effect,
      requiresConfirmation: tool.requiresConfirmation,
    }));
  }

  /**
   * 复现真注册表的调用两步：先过声明自己的 schema，再打实现。
   *
   * 实现抛错时**原样上抛**（真注册表把它收成 `TOOL_FAILED`，那一步由 `agent` 包的用例断言）——
   * 本包的用例要断言的是 `CONSENT_REQUIRED` / `QUOTA_EXCEEDED` 这些闸门自己的错误码。
   * @param id 工具 id
   * @param rawInput 未收窄的入参（来自模型或界面，按不可信输入处理）
   * @returns schema 通过时是实现产出的统一读数（spec 5.1-11 的 `ToolResult`）；不通过时带回 `INPUT_INVALID`，id 没登记带回 `NOT_REGISTERED`
   */
  async call(id: string, rawInput: unknown): Promise<{ ok: true; result: ToolResult } | { ok: false; reason: string }> {
    const tool = this.declarations.get(id);
    if (!tool) return { ok: false, reason: 'NOT_REGISTERED' };
    const parsed = tool.input.safeParse(rawInput);
    if (!parsed.success) return { ok: false, reason: 'INPUT_INVALID' };
    return { ok: true, result: await tool.run(parsed.data) };
  }
}

/**
 * 假的 `jd.store`：回答「这条岗位对方回过没有」与「这条岗位在不在库里」两问。
 *
 * 存在理由是择机投递（spec 5.7-03）把回复状态列为四个输入之一，而真身在 `platform-boss` 包里、
 * 挂着 sqlite 与浏览器层——外发层的用例只需要「回过 / 没回过 / 库里没这条」三态。
 * 三态必须能拨：`null` 那一支是这条规则最要紧的边界（问不到就**不动手**，见 plan §7.5.5 决策七）。
 * 5.7-f 起它还答第二问（话术生成前查岗位键有没有出处），两问共用同一张表。
 */
export class FakeJdReplyStatusService extends Service implements JdReplyStatusSource, JdKeySource {
  static provide = 'jd.store';
  static Config = z.strictObject({});

  /** 每条岗位的回答；缺键就是「库里没有这条」，与真身的 `replyStatus` 同语义。 */
  private readonly statuses = new Map<string, boolean>();

  /** 被问了多少次（现问的读数：一次判定只该问一次，不缓存）。 */
  asks = 0;

  /** 存在性被问了多少次（spec 5.7-f 同一条读数：话术生成在问模型之前问一次）。 */
  keyAsks = 0;

  constructor(ctx: Context, _options: Record<string, never>) {
    super(ctx, 'jd.store');
  }

  /**
   * 设定一条岗位的回复状态。
   * @param platform 平台标识
   * @param jobId 岗位标识
   * @param replied true 回过、false 一条没回
   */
  set(platform: string, jobId: string, replied: boolean): void {
    this.statuses.set(`${platform}/${jobId}`, replied);
  }

  /** 契约见 `JdReplyStatusSource.replyStatus`；未设定过即 null（库里没有这条）。 */
  replyStatus = (platform: string, jobId: string): boolean | null => {
    this.asks += 1;
    return this.statuses.get(`${platform}/${jobId}`) ?? null;
  };

  /**
   * 契约见 `JdKeySource.hasJob`。与上面一问共用同一张 `statuses`——`set` 过就是库里有这条，
   * 再存一份"已知岗位"表就是第二套事实（§2.7）。不区分平台：真身按 `job_id` 取最近一条，同判据。
   */
  hasJob = (jobId: string): boolean => {
    this.keyAsks += 1;
    for (const key of this.statuses.keys()) if (key.endsWith(`/${jobId}`)) return true;
    return false;
  };
}
