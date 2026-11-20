/**
 * `journey.unattended` 服务（spec 10.6 / plan §12.2 第 5 片）：无人值守执行器。
 *
 * 它**不是第二套 runner**：没有计划库、没有第二张运行表、没有第二套计数。一次运行的全部事实来自三处既有来源——
 * 授权单（`outbound.authorization.current()`：范围、窗口、状态、待办）、账本（`usage.ledger.attemptFor()` 的成功位、
 * 停用位）、以及各笔外发自己的回执（greet/deliver 的 `ledgerId`）。所以进程重启后「跑到哪了」不需要从本服务读：
 * 授权单转 `restart-required`，成功位还在账本里，待办由两者相减现算。
 *
 * 每岗的顺序固定为 **定制 → 招呼 → 投递**，三步都是既有服务：
 * ① `journey.tailor`（生成/接受/事实校验都在既有生成轨里，违规即整份失败）；
 * ② `outbound.greet.perform`（带 `unattended: true`，先过授权与额度闸门）；
 * ③ `resume.export.toPdf` + `outbound.deliver.perform`（同样带 `unattended: true`）。
 * 停止条件在每岗开始与每笔发送之前各问一次：授权状态（暂停/过期/被收回）、停用位、取消标记。
 * 风控由 `outbound.authorization` 订阅 `browser/risk-signal` 后把单子置 `paused` 并发 `outbound/authorization-paused`，
 * 本服务不识别验证码、不重试、不自动恢复。
 *
 * 内存态只记「这次进程里跑到哪一步」用于界面显示；它不是断点来源，进程一退就没了（那正是安全要求）。
 */
import { AppError, asApp, Service, sleep, type Context } from '@auto-cc/core';
import type { UnattendedRunState, UnattendedRunView, UnattendedStartInput } from '@auto-cc/shared';
import { z } from 'zod';

/** 内部入参：跨进程形状之外只多一个可注入的判定时刻（用例造跨日用，界面不给）。 */
export type UnattendedStartRequest = UnattendedStartInput & { nowMs?: number };

/** 授权单的窄形状（本包不 import 外发包，按名字现问，§2.7）。 */
interface AuthorizationSource {
  current(nowMs?: number): {
    platform: string;
    status: string;
    targets: readonly string[];
    resumeVersion: string;
  } | null;
}

/** 账本的窄形状：成功位与停用位都从这一处现问。 */
interface LedgerSource {
  attemptFor(key: {
    platform: string;
    targetId: string;
    action: 'greet' | 'deliver';
    resumeVersion: string;
  }): { status: string; ledgerId: number | null } | null;
  /** 同岗同平台的招呼与投递都成功过（不看版本：逐岗定制出的版本不同，完成口径按岗位算）。 */
  hasCompletedJob(platform: string, targetId: string): boolean;
  outboundStatus(): { stopped: boolean };
}

/** 生成轨的窄形状。 */
interface TailorSource {
  tailor(input: { docId: string; jobId: string; platform?: string }): Promise<{
    tailoredDocId: string | null;
    tailoredResumeVersion: string | null;
    greeting: { text: string } | null;
  }>;
}

/** 外发入口的窄形状：`perform` 内部的授权/额度/去重/落账一律不在这里重写。 */
interface SendSource {
  perform(raw: Record<string, unknown>): Promise<{ ledgerId: number | null }>;
}

/** 导出服务的窄形状：投递要的是真文件与不可变快照 id。 */
interface ExportSource {
  toPdf(docId: string): Promise<{ path: string; snapshotId: string }>;
}

/** 节奏来源：只问「隔多久」，本服务负责真的让出。 */
interface ThrottleSource {
  nextGapMs(): number;
}

/**
 * 执行器配置：只有一个「单步上限」。它防的是页面动作卡死把整轮无声挂住——超时按该岗失败记账并继续，
 * 不重试、不自动恢复。默认 120s：页面导航与上传的既有等待上限都在这个量级以内。
 */
export const unattendedSchema = z.strictObject({
  stepTimeoutMs: z.number().int().min(1_000).max(600_000).default(120_000),
});

/** 校验后的配置形状。 */
export type UnattendedConfig = z.infer<typeof unattendedSchema>;

export class JourneyUnattendedService extends Service {
  static provide = 'journey.unattended';
  static Config = unattendedSchema;
  static inject = [
    'journey',
    'outbound.authorization',
    'outbound.greet',
    'outbound.deliver',
    'resume.export',
    'outbound.throttle',
    'usage.ledger',
  ];

  private status: UnattendedRunState = 'idle';
  private runId: string | null = null;
  private startedAt: number | null = null;
  private finishedAt: number | null = null;
  private currentTarget: string | null = null;
  private lastError: string | null = null;
  private cancelRequested = false;
  private readonly completed: { jobId: string; greetLedgerId: number; deliverLedgerId: number }[] = [];
  private readonly failed: { jobId: string; code: string; message: string }[] = [];
  private pending: string[] = [];

  constructor(
    ctx: Context,
    private readonly config: UnattendedConfig,
  ) {
    super(ctx, 'journey.unattended');
  }

  /**
   * 给单步外发加一个上限：页面动作卡死时按超时失败收尾，整轮不被挂住。
   * @param promise 实际步骤
   * @param label 步骤名（进超时错误详情）
   * @returns 步骤结果
   * @throws `UNATTENDED_STEP_TIMEOUT`：超过 `stepTimeoutMs`
   */
  private async withStepTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new AppError(
                  'UNATTENDED_STEP_TIMEOUT',
                  `无人值守单步超时（${label}，上限 ${String(this.config.stepTimeoutMs)}ms）`,
                  'journey.unattended',
                ),
              ),
            this.config.stepTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** 服务句柄：每笔外发都现问，不在本服务里存第二份事实。 */
  private get tailor(): TailorSource {
    return asApp(this.ctx)['journey'];
  }

  private get authorization(): AuthorizationSource {
    return asApp(this.ctx)['outbound.authorization'];
  }

  private get ledger(): LedgerSource {
    return asApp(this.ctx)['usage.ledger'];
  }

  private get greet(): SendSource {
    return asApp(this.ctx)['outbound.greet'];
  }

  private get deliver(): SendSource {
    return asApp(this.ctx)['outbound.deliver'];
  }

  private get exporter(): ExportSource {
    return asApp(this.ctx)['resume.export'];
  }

  private get throttle(): ThrottleSource {
    return asApp(this.ctx)['outbound.throttle'];
  }

  /**
   * 开始一轮无人值守：只做前置校验并起后台循环，立即返回视图（界面轮询 `view()`）。
   * @param input 母版、平台、运行 id 与判定时刻
   * @returns 起跑瞬间的运行视图（此时 `status` 已是 `running`）
   * @throws `INVALID_ARGUMENT` 已有一轮在跑；`AUTHORIZATION_RECONFIRM_REQUIRED` / `AUTHORIZATION_WINDOW_CLOSED` /
   *         `UNATTENDED_NOT_AUTHORIZED` 授权单不在可跑状态（重启、跨日、被收回）
   */
  start = (input: UnattendedStartRequest): UnattendedRunView => {
    if (this.status === 'running') {
      throw new AppError('INVALID_ARGUMENT', '已有一轮无人值守在跑，先等它结束或停用', 'journey.unattended', {
        runId: this.runId,
      });
    }
    const nowMs = input.nowMs ?? Date.now();
    const authorization = this.authorization.current(nowMs);
    if (authorization === null || authorization.status === 'revoked' || authorization.status === 'expired') {
      throw new AppError(
        'UNATTENDED_NOT_AUTHORIZED',
        '没有有效的无人值守授权单，先由人开一张再开始',
        'journey.unattended',
      );
    }
    if (authorization.status === 'restart-required') {
      throw new AppError(
        'AUTHORIZATION_RECONFIRM_REQUIRED',
        '授权单来自上一次运行（或应用重启过）：先确认续跑，再开始执行器',
        'journey.unattended',
      );
    }
    if (authorization.status === 'paused') {
      throw new AppError('OUTBOUND_RISK_PAUSED', '本轮处于暂停状态：先由人确认续跑', 'journey.unattended');
    }
    const platform = input.platform ?? authorization.platform;
    this.runId = input.runId ?? `unattended-${String(nowMs)}`;
    this.status = 'running';
    this.startedAt = nowMs;
    this.finishedAt = null;
    this.currentTarget = null;
    this.lastError = null;
    this.cancelRequested = false;
    this.completed.length = 0;
    this.failed.length = 0;
    this.pending = this.pendingOf(platform, authorization);
    this.ctx.logger.info(
      `无人值守开跑：运行 ${this.runId} · 平台 ${platform} · 待办 ${String(this.pending.length)} 岗`,
    );
    // 后台循环不 await：start 只负责「开跑」这一件事，进度从 view() 读。
    void this.run(input.docId, platform).catch((error: unknown) => {
      this.finish('failed', error instanceof Error ? error.message : String(error));
    });
    return this.view(nowMs);
  };

  /**
   * 主动请求停止：只置取消标记，由循环在下一个检查点退出；真正的「立即停止后续外发」仍由
   * `entitlement.gate` 的停用位保证（本函数不绕开它）。
   * @param nowMs 请求时刻（毫秒）
   * @returns 请求后的视图（仍在 `running`，等循环收尾）
   */
  stop = (nowMs = Date.now()): UnattendedRunView => {
    if (this.status === 'running') {
      this.cancelRequested = true;
      this.ctx.logger.info(`无人值守收到停止请求：运行 ${String(this.runId)}`);
    }
    return this.view(nowMs);
  };

  /**
   * 读当前运行视图；待办按授权单与账本成功位现算，不读本服务的历史。
   * @param nowMs 判定时刻（毫秒）
   * @returns 只读视图
   */
  view = (nowMs = Date.now()): UnattendedRunView => {
    const authorization = this.authorization.current(nowMs);
    const pending = authorization === null ? [] : this.pendingOf(authorization.platform, authorization);
    return {
      status: this.status,
      runId: this.runId,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      currentTarget: this.currentTarget,
      completed: [...this.completed],
      failed: [...this.failed],
      pending,
      lastError: this.lastError,
    };
  };

  /**
   * 哪些岗位还没推完：账本里「打招呼成功」与「投递成功」都有的岗位算完成。
   * @param platform 平台
   * @param authorization 授权单读数（提供岗位集合与版本）
   * @returns 待办岗位 id 列表（保持授权单顺序）
   */
  private pendingOf(platform: string, authorization: { targets: readonly string[]; resumeVersion: string }): string[] {
    return authorization.targets.filter((targetId) => !this.ledger.hasCompletedJob(platform, targetId));
  }

  /**
   * 后台主循环：逐岗 定制 → 招呼 → 投递；每岗开始与每笔发送前各过一次守卫。
   * @param docId 母版简历 id
   * @param platform 平台
   */
  private async run(docId: string, platform: string): Promise<void> {
    try {
      for (const jobId of this.pending) {
        try {
          this.guard(platform, jobId);
          this.currentTarget = jobId;
          const tailored = await this.withStepTimeout(this.tailor.tailor({ docId, jobId, platform }), 'tailor');
          if (!tailored.tailoredDocId || !tailored.tailoredResumeVersion || tailored.greeting === null) {
            this.failed.push({ jobId, code: 'TAILOR_INCOMPLETE', message: '定制结果不完整（缺变体或招呼）' });
            continue;
          }
          const greeted =
            this.ledger.attemptFor({
              platform,
              targetId: jobId,
              action: 'greet',
              resumeVersion: tailored.tailoredResumeVersion,
            })?.status === 'succeeded';
          let greetLedgerId = 0;
          if (greeted) {
            greetLedgerId = this.ledgerIdOf(platform, jobId, 'greet', tailored.tailoredResumeVersion);
          } else {
            this.guard(platform, jobId);
            const receipt = await this.withStepTimeout(
              this.greet.perform({
                platform,
                jobId,
                text: tailored.greeting.text,
                resumeVersion: tailored.tailoredResumeVersion,
                workflowRunId: this.runId,
                unattended: true,
              }),
              'greet',
            );
            greetLedgerId = receipt.ledgerId ?? 0;
          }
          this.guard(platform, jobId);
          const exported = await this.withStepTimeout(this.exporter.toPdf(tailored.tailoredDocId), 'export');
          this.guard(platform, jobId);
          const delivered = await this.withStepTimeout(
            this.deliver.perform({
              platform,
              jobId,
              filePath: exported.path,
              snapshotId: exported.snapshotId,
              resumeVersion: tailored.tailoredResumeVersion,
              workflowRunId: this.runId,
              unattended: true,
            }),
            'deliver',
          );
          this.completed.push({ jobId, greetLedgerId, deliverLedgerId: delivered.ledgerId ?? 0 });
        } catch (error) {
          // 单步超时/单岗失败不拖垮整轮：这一岗记失败、继续下一岗；授权/停用/风控/额度/事实违规仍整轮停。
          const code = error instanceof AppError ? error.code : 'UNATTENDED_FAILED';
          if (this.isFatal(code)) throw error;
          this.failed.push({ jobId, code, message: error instanceof Error ? error.message : String(error) });
          this.ctx.logger.warn(`无人值守单岗失败（${code}）：${jobId}`);
        }
        // 岗与岗之间按既有节奏再让出一段：无人值守不是把间隔关掉的理由（plan §12.2.3）。
        if (jobId !== this.pending[this.pending.length - 1]) await sleep(this.throttle.nextGapMs());
      }
      this.finish(this.cancelRequested ? 'stopped' : 'done', null);
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'UNATTENDED_FAILED';
      const message = error instanceof Error ? error.message : String(error);
      const state: UnattendedRunState = this.cancelRequested
        ? 'stopped'
        : code === 'OUTBOUND_DISABLED'
          ? 'stopped'
          : code === 'OUTBOUND_RISK_PAUSED' ||
              code === 'AUTHORIZATION_RECONFIRM_REQUIRED' ||
              code === 'AUTHORIZATION_WINDOW_CLOSED' ||
              code === 'OUTBOUND_TARGET_NOT_AUTHORIZED' ||
              code === 'OUTBOUND_RESUME_VERSION_NOT_AUTHORIZED'
            ? 'paused'
            : code === 'AUTHORIZATION_QUOTA_EXHAUSTED' || code === 'QUOTA_EXCEEDED'
              ? 'blocked'
              : 'failed';
      this.lastError = message;
      this.ctx.logger.warn(`无人值守中止（${code}）：${message}`);
      this.finish(state, message);
    }
  }

  /**
   * 哪些错误让整轮停下（其余按单岗失败记账后继续）。
   * @param code 错误码
   * @returns 需要中止整轮时为 true
   */
  private isFatal(code: string): boolean {
    return [
      'OUTBOUND_DISABLED',
      'OUTBOUND_RISK_PAUSED',
      'AUTHORIZATION_RECONFIRM_REQUIRED',
      'AUTHORIZATION_WINDOW_CLOSED',
      'UNATTENDED_NOT_AUTHORIZED',
      'OUTBOUND_TARGET_NOT_AUTHORIZED',
      'OUTBOUND_RESUME_VERSION_NOT_AUTHORIZED',
      'AUTHORIZATION_QUOTA_EXHAUSTED',
      'QUOTA_EXCEEDED',
      'JOURNEY_FACT_BLOCKED',
    ].includes(code);
  }

  /**
   * 每岗开始与每笔发送之前的守卫：取消标记 → 停用位 → 授权单仍是 active。
   * @param platform 平台（授权单必须仍覆盖它）
   * @param jobId 当前岗位（用于拒绝原因可读）
   * @throws `OUTBOUND_DISABLED` / `OUTBOUND_RISK_PAUSED` / `AUTHORIZATION_WINDOW_CLOSED` / `UNATTENDED_NOT_AUTHORIZED`
   */
  private guard(platform: string, jobId: string): void {
    if (this.cancelRequested) {
      throw new AppError('OUTBOUND_DISABLED', '本轮已收到停止请求，不再发起新外发', 'journey.unattended', { jobId });
    }
    if (this.ledger.outboundStatus().stopped) {
      throw new AppError('OUTBOUND_DISABLED', '外发已一键停用：本轮停止，不再发起新外发', 'journey.unattended', {
        jobId,
      });
    }
    const authorization = this.requireActiveAuthorization();
    if (authorization.platform !== platform) {
      throw new AppError('OUTBOUND_TARGET_NOT_AUTHORIZED', `授权单不覆盖平台 ${platform}`, 'journey.unattended', {
        jobId,
      });
    }
  }

  /** 现读授权单并要求它是 active；否则按中止语义抛结构化错误。 */
  private requireActiveAuthorization(): {
    platform: string;
    status: string;
    targets: readonly string[];
    resumeVersion: string;
  } {
    const authorization = this.authorization.current(Date.now());
    if (authorization === null) {
      throw new AppError('UNATTENDED_NOT_AUTHORIZED', '授权单不存在了，本轮停止', 'journey.unattended');
    }
    if (authorization.status === 'paused') {
      throw new AppError('OUTBOUND_RISK_PAUSED', '授权单已被风控暂停，需要人确认后才能续跑', 'journey.unattended');
    }
    if (authorization.status === 'restart-required') {
      throw new AppError(
        'AUTHORIZATION_RECONFIRM_REQUIRED',
        '授权单已转待办（重启/上次未完成），需要人确认后续跑',
        'journey.unattended',
      );
    }
    if (authorization.status === 'expired') {
      throw new AppError('AUTHORIZATION_WINDOW_CLOSED', '授权窗口已关闭（跨日），不再自动续跑', 'journey.unattended');
    }
    if (authorization.status !== 'active') {
      throw new AppError(
        'UNATTENDED_NOT_AUTHORIZED',
        `授权单状态 ${authorization.status} 不允许继续跑`,
        'journey.unattended',
      );
    }
    return authorization;
  }

  /** 从账本里取某笔成功外发的账行 id（断点续跑时用来补齐完成读数的引用）。 */
  private ledgerIdOf(platform: string, jobId: string, action: 'greet' | 'deliver', resumeVersion: string): number {
    const attempt = this.ledger.attemptFor({ platform, targetId: jobId, action, resumeVersion });
    return attempt?.ledgerId === null || attempt?.ledgerId === undefined ? 0 : Number(attempt.ledgerId);
  }

  /** 收尾：写终态与结束时刻（幂等，重复调用不覆盖第一次的终态）。 */
  private finish(state: UnattendedRunState, error: string | null): void {
    if (this.status !== 'running') return;
    this.status = state;
    this.finishedAt = Date.now();
    this.currentTarget = null;
    if (error !== null) this.lastError = error;
    this.ctx.logger.info(
      `无人值守收尾：${state} · 完成 ${String(this.completed.length)} 岗 · 失败 ${String(this.failed.length)} 岗` +
        (error === null ? '' : ` · 原因 ${error}`),
    );
  }

  [Service.init](): void {
    this.ctx.logger.info('无人值守执行器就绪：只按授权单顺序调既有生成/招呼/投递，不持有第二份计划或计数');
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'journey.unattended': JourneyUnattendedService;
  }
}
