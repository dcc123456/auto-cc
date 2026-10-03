/**
 * `outbound.deliver` 服务（spec 2.6-01 / 02 / 03 / 05 / 06 / 07）：简历投递的唯一编排入口。
 *
 * 它按 plan §13.3 第 3 条切成两段：`stage` 只做**离开 app 之前**的准备工作（现问渠道、校验文件、
 * 算 hash、查幂等），不发、不落账、不进闸门；`commit` 才走打招呼那条顺序——额度先查后等 →
 * 频控（以账本最近一条 `deliver` 为钟）→ 审批（按档位）→ 渠道发送 → 页面回读 → `gate.perform`。
 * 切成两段是因为「仅辅助」档（2.6-06）要的正是这个中间态：界面上摆出「要递什么」但一个字都不发。
 *
 * 与打招呼的两处实质差别：
 * ① 多一道**页面二次校验**——库里那条 JD 是抓取那一刻的快照，只有页面能回答「现在还在不在收」，
 *    所以校验发生在适配器里（`DELIVER_TARGET_OFFLINE`），不在这里；
 * ② 多一个**等人**的环节——档位 `semi`（默认）在发送前必须有人在 app 内点确认，超时按拒绝。
 *    这台状态机做在本服务里而不是界面里：投递有两个入口（工作流节点、界面单发），
 *    把「等人」做在界面那一侧，第二个入口必然漏一套（AGENTS.md §2.5）。
 *    「等人」的**机制**（单号、登记表、超时、让出、收单）在 5.3-c 抽到了 `@auto-cc/core` 的
 *    `PendingChannel`，因为对话循环成了这台机器的第二个用户；本服务留下的只有领域那半边：
 *    卡片上写哪几格，以及三种定局各映射成哪个错误码。
 *
 * 和打招呼一样，它**不认识任何平台也不保存任何平台的手**：每次现向 `platform.registry` 问渠道
 * （plan §12.13 的教训——自己持表会被配置热重载清空）。
 */
import {
  AppError,
  asApp,
  assertNotYielded,
  consentGateOf,
  deliverChannelsOf,
  executorRegistryOf,
  PendingChannel,
  Service,
  sleep,
  type Context,
  type PendingRequest,
  type ResumeAttachment,
  type ResumeDeliveryChannel,
  type WorkflowNodeExecutor,
  agentTool,
  registerAgentTools,
  toolResult,
} from '@auto-cc/core';
import type {
  DeliverApprovalView,
  DeliverAttachmentView,
  DeliverReceiptView,
  DeliverRequestView,
} from '@auto-cc/shared';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** 额度键与账本动作名（`entitlement.gate` 按它数日上限，spec 2.6-02 / 03）。 */
export const DELIVER_ACTION = 'deliver';

/** 工作流节点名（plan §13.3 第 1 条）；与 `greeting.send` 同一命名口径。 */
export const DELIVER_NODE_KIND = 'resume.deliver';

/**
 * 「定制简历」那一格的节点名（spec 2.8-07 / plan §15.9 决策 2）。
 *
 * P2 它是**占位**：只把这次要发出去的简历文件定下来，一个字都不按岗位改（生成轨属 P3）。
 * 之所以仍要单独一格，而不是让投递节点自己去读配置——M6 的全链路截图里必须看得见「定制」这一步
 * 到底做没做，藏进投递节点内部就等于在验收照片里撒了个谎。
 */
export const CUSTOMIZE_NODE_KIND = 'resume.customize';

/**
 * 「定制简历」这一步的读数（spec 2.8-07 的占位格）。
 *
 * `customized` 恒为 `false` 是有意的：把「没做定制」做成一个**字段**而不是文案，
 * 界面与验收记录就拿到的是一个可核对的读数，将来 P3 真做定制时它翻成 `true`，
 * 而不用去改一句写死的话。
 */
export type ResumeCustomizeView = {
  platform: string;
  jobId: string;
  /** 定下来的简历文件绝对路径——`resume.deliver` 那一步用的就是它（同一条解析，见 `resolveResumePath`） */
  filePath: string;
  fileName: string;
  /** 文件字节数（读文件系统得到，不是猜的；为 0 也算读数） */
  bytes: number;
  /** P2 恒 false：没有按岗位改过任何一个字 */
  customized: false;
};

/** 投递档位：直接复用 `AutonomyLevel`，不新造枚举（plan §13.3 第 3 条）。 */
const autonomyLevelSchema = z.enum(['suggest', 'semi', 'auto']);

/**
 * `suggest` 与 `auto` 之间的那一档是默认值：2.6 的整条主线就是「投递前问一句人」（spec 2.6-01），
 * 默认值一旦是 `auto`，装好 app 不做任何设置就会往真实站点上自动递简历。
 */
export const deliverSchema = z.strictObject({
  /** 当前档位（spec 2.6-01 / 06）：只准备 / 确认后发 / 免审批发 */
  autonomy: autonomyLevelSchema.default('semi'),
  /** 等人确认的时长上限（毫秒）；到点按**拒绝**处理——没人表态永远不等于同意 */
  approveTimeoutMs: z.number().int().min(0).max(3_600_000).default(120_000),
  /** 简历大小上限（字节）：超了连 stage 都过不去，不去页面上赌站点会不会收 */
  maxResumeBytes: z.number().int().min(1024).max(52_428_800).default(5_242_880),
  /** 默认简历路径；请求里没带 `filePath` 时用它（P3 之前的临时入口，plan §13.5） */
  resumeFile: z.string().min(1).optional(),
});

/** 校验后的配置形状（调用点与测试引用它，而不是手写一遍 zod 推断）。 */
export type DeliverConfig = z.output<typeof deliverSchema>;

/**
 * 投递请求的入站校验（渲染层与计划都是不可信来源，AGENTS.md §2.6）。
 *
 * `title` / `company` 只服务于确认卡片：JD 行的查询面还没接（plan §13.7 第 1 条），
 * 所以「递给谁」这句话由调用方带进来，而不是这里去库里猜。
 */
const deliverRequestSchema = z.strictObject({
  platform: z.string().min(1),
  jobId: z.string().min(1),
  filePath: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  company: z.string().min(1).optional(),
  /** 这次用的是哪一版导出产物（`resume_snapshots.snapshot_id`）；省略表示只给了文件、没有导出上下文（spec 3.7-02） */
  snapshotId: z.string().min(1).optional(),
  workflowRunId: z.string().min(1).nullish(),
  nowMs: z.number().int().positive().optional(),
});

/**
 * 一次已备好、尚未发送的投递（`stage` 的产物，`commit` 的输入）。
 *
 * 它是**值对象**而不是句柄：里面没有任何指向页面的引用，所以「stage 完先去干别的、回来再 commit」
 * 不会因为适配器换人而失效——commit 时按 `platform` 现问渠道（同 plan §12.13）。
 */
export type StagedDelivery = {
  platform: string;
  jobId: string;
  title: string;
  company: string;
  attachment: ResumeAttachment;
  workflowRunId: string | null;
  /** 判定与落账的基准毫秒，冻结在 stage 那一刻：commit 侧不再读当前时间，等间隔才算得准 */
  nowMs: number;
  /** 账本 `source`：`resume:<sha256 前 12 位>@<文件名>`（spec 2.6-05，复用已有的 `source` 列） */
  source: string;
  /** 这一版简历的快照 id（spec 3.7-02）；只给了文件路径、没有导出上下文时为 null */
  snapshotId: string | null;
};

/**
 * 确认单上除了单号与时刻之外的那几格——那三位由 `PendingChannel` 补齐（5.3-c 抽的公共通道）。
 */
type ApprovalPayload = Omit<DeliverApprovalView, 'approvalId' | 'requestedAt' | 'expiresAt'>;

/**
 * 把通道里的等待读数拼成跨 IPC 的确认单视图。
 * @param request 通道读数（单号 + 开单时刻 + 到点时刻 + 卡片载荷）
 * @returns 界面认识的那个形状：单号这一列沿用的是 2.6-c 定下的 `approvalId`，不改名
 */
function approvalView(request: PendingRequest<ApprovalPayload>): DeliverApprovalView {
  const { requestId, ...payload } = request;
  return { approvalId: requestId, ...payload };
}

/**
 * 把节点参数里的字符串读出来（缺键或非字符串都返回 null，由调用方报缺参数）。
 * @param value `spec.params` 里的原始值（声明值类型是 string/number/boolean）
 * @returns 非空字符串本身，否则 null
 */
function paramString(value: string | number | boolean | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * 附件摆在界面上的那三样（不含路径，理由见 `DeliverAttachmentView`）。
 * @param attachment 完整的附件读数
 * @returns 展示用的窄化视图
 */
function attachmentView(attachment: ResumeAttachment): DeliverAttachmentView {
  return { fileName: attachment.fileName, sizeBytes: attachment.sizeBytes, sha256: attachment.sha256 };
}

export class OutboundDeliverService extends Service {
  static provide = 'outbound.deliver';
  static Config = deliverSchema;
  // 闸门/账本/频控与打招呼同源；`platform.registry` 是硬依赖——没有平台层就没有递简历的手。
  // 与打招呼的差别是不需要 `outbound.script`：2.6-b 只递文件，不随信正文（plan §13.7 第 2 条）。
  // `outbound.deliveries`（spec 3.7-02）也是硬依赖：摘掉它投递连同进 PENDING，而不是「递出去了但没留下可追溯的经过」——
  // 与 `resume.export` 硬依赖 `resume.snapshot`（导出即留档，不许只出 PDF）同一条取向。
  static inject = [
    'entitlement.gate',
    'usage.ledger',
    'outbound.throttle',
    'outbound.deliveries',
    'platform.registry',
    'sessions',
  ];

  /**
   * 在等的确认单（5.3-c 起是共用通道的一个实例）。
   *
   * 为什么是内存登记表而不是库里一张表：它是一次**等待**的状态，不是事实记录——投递的真相永远在
   * 账本那一行里（成功才有行）。做成表就要处理「进程死了谁把 in-flight 的单子收掉」，
   * 而超时按拒绝这条性质本来就把所有悬挂兜住了（plan §13.3 第 2 条）。
   * 应答值的类型是 `boolean`：这一张卡片问的只有「发 / 不发」。
   */
  private readonly approvals = new PendingChannel<ApprovalPayload, boolean>();

  constructor(
    ctx: Context,
    private readonly config: DeliverConfig,
  ) {
    super(ctx, 'outbound.deliver');
  }

  /**
   * 闸门句柄：与打招呼共用同一个 `entitlement.gate`，只是动作键换成 `deliver`（spec 2.6-02）。
   * @returns 额度闸门服务实例
   */
  private get gate() {
    return asApp(this.ctx)['entitlement.gate'];
  }

  /**
   * 账本句柄：幂等判据与频控的钟都从它读，不在本服务里另存一份「上次什么时候发的」（§2.7）。
   * @returns 用量账本服务实例
   */
  private get ledger() {
    return asApp(this.ctx)['usage.ledger'];
  }

  /**
   * 投递记录句柄：账本数额度，这里记经过（spec 3.7-02）——两条读路径各查各的表，没有第二套计数。
   * @returns 投递记录服务实例
   */
  private get deliveryRecords() {
    return asApp(this.ctx)['outbound.deliveries'];
  }

  /**
   * 解析「这次要用哪份简历文件」：请求带的路径优先，没带用配置的 `resumeFile`。
   *
   * 抽成一个方法是因为两处都要这条判断（`stage` 投递前、`customize` 定制格），
   * 而两条路径必须给出**同一个**答案——占位格报出来的文件和真正递出去的文件不是同一份，
   * 那一格就成了摆设（AGENTS.md §2.2）。
   * @param requested 请求里显式给的路径（工具/界面入口用得上）
   * @param jobId 只用于把错误说得清（哪个岗位等这份简历）
   * @returns 简历文件的绝对路径
   * @throws 两个来源都没给时 `INVALID_ARGUMENT`
   */
  private resolveResumePath(requested: string | undefined, jobId: string): string {
    const filePath = requested ?? this.config.resumeFile;
    if (!filePath) {
      throw new AppError(
        'INVALID_ARGUMENT',
        '没有要投递的简历文件：请求里没带 filePath，配置里也没设 resumeFile',
        'outbound.deliver',
        { jobId },
      );
    }
    return filePath;
  }

  /**
   * 准备好一次投递：现问渠道 → 校验文件 → 算 hash → 查幂等（spec 2.6-06 要的中间态）。
   * @param raw 请求（见 `deliverRequestSchema`）；`filePath` 省略时取配置里的 `resumeFile`
   * @returns 已备好的投递（含附件三要素与 `source`），**尚未发出、尚未进闸门、尚未落账**
   *          ——同步返回：这一段没有一处异步（读文件与算 hash 都是同步 API），所以不假装是 Promise
   * @throws `INVALID_ARGUMENT`（入参不合法、没给路径、文件读不出、不是 pdf、超过大小上限）、
   *         `OUTBOUND_CHANNEL_MISSING`（该平台没有带 sendResume 的适配器）、
   *         `OUTBOUND_ALREADY_SENT`（同 run 同 target 已经递过一次）
   */
  stage = (raw: unknown): StagedDelivery => {
    const parsed = deliverRequestSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `投递请求不合法：${parsed.error.issues[0]?.message ?? ''}`,
        'outbound.deliver',
      );
    }
    const { platform, jobId, title, company } = parsed.data;
    const nowMs = parsed.data.nowMs ?? Date.now();
    const runId = parsed.data.workflowRunId ?? null;
    const filePath = this.resolveResumePath(parsed.data.filePath, jobId);

    // 渠道在准备工作里就问（同打招呼的理由）：平台名写错要在**读文件、算 hash 之前**就失败，
    // 而不是让人在界面上确认完一份永远递不出去的简历。
    const sources = deliverChannelsOf(this.ctx);
    if (!sources?.deliverChannel(platform)) {
      throw new AppError('OUTBOUND_CHANNEL_MISSING', `平台 ${platform} 现在没有可用的投递渠道`, 'outbound.deliver', {
        platform,
        deliverable: sources?.deliverablePlatforms() ?? [],
      });
    }
    const attachment = this.readAttachment(filePath);

    // 幂等判据与打招呼同一条：(action, target, run) 有没有落成过一行（spec 2.5-13 的口径搬到投递）。
    if (this.ledger.countFor(DELIVER_ACTION, jobId, runId) > 0) {
      throw new AppError(
        'OUTBOUND_ALREADY_SENT',
        `目标 ${jobId} 在本次运行里已经递过简历，不再重复发送`,
        'outbound.deliver',
        { jobId, workflowRunId: runId },
      );
    }
    return {
      platform,
      jobId,
      title: title ?? '',
      company: company ?? '',
      attachment,
      workflowRunId: runId,
      nowMs,
      // spec 2.6-05：hash 取前 12 位就够对上了——完整的 64 位串在账本里没人读，而 3.7 的 diff 按前缀能join。
      source: `resume:${attachment.sha256.slice(0, 12)}@${attachment.fileName}`,
      snapshotId: parsed.data.snapshotId ?? null,
    };
  };

  /**
   * 读并校验那份简历文件（spec 2.6-06 的「校验文件」半边）。
   * @param filePath 简历的绝对或相对路径
   * @returns 附件读数：路径、文件名、字节数、整份文件的 sha256（十六进制小写）
   * @throws `INVALID_ARGUMENT`——读不出（不存在/没权限/是个目录）、不是 `.pdf`、或超过 `maxResumeBytes`。
   *         三种都在这里合成一个码是有意的：对调用方来说它们都是「这份文件现在不能递」，
   *         区别只在 `message` 与 `details`，不值得为它开三个错误码
   */
  private readAttachment(filePath: string): ResumeAttachment {
    let sizeBytes: number;
    try {
      const stats = statSync(filePath);
      if (!stats.isFile()) throw new Error('不是一个文件');
      sizeBytes = stats.size;
    } catch (error) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `简历文件读不出：${filePath}（${error instanceof Error ? error.message : String(error)}）`,
        'outbound.deliver',
        { filePath },
      );
    }
    if (path.extname(filePath).toLowerCase() !== '.pdf') {
      throw new AppError('INVALID_ARGUMENT', `简历只支持 pdf，给的是 ${filePath}`, 'outbound.deliver', { filePath });
    }
    if (sizeBytes > this.config.maxResumeBytes) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `简历 ${String(sizeBytes)} 字节，超过上限 ${String(this.config.maxResumeBytes)} 字节`,
        'outbound.deliver',
        { filePath, sizeBytes },
      );
    }
    let content: Buffer;
    try {
      content = readFileSync(filePath);
    } catch (error) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `简历文件读取失败：${filePath}（${error instanceof Error ? error.message : String(error)}）`,
        'outbound.deliver',
        { filePath },
      );
    }
    return {
      path: filePath,
      fileName: path.basename(filePath),
      sizeBytes,
      sha256: createHash('sha256').update(content).digest('hex'),
    };
  }

  /**
   * 把一次已备好的投递真正发出去（spec 2.6-01 / 02 / 03 / 07 的落地半边）。
   *
   * 顺序与打招呼逐字对齐，中间只多一步审批：额度**先查后等**（到量即停，不该白等一个频控间隔）→
   * 频控 → 审批（按档位）→ 发送 → 页面回读 → `gate.perform` 落账 → `outbound.deliveries` 记一条经过（spec 3.7-02）。
   * @param staged `stage` 的产物
   * @param signal 让出信号，工作流节点路径用它响应暂停；界面路径传 undefined
   * @returns 投递回执（`committed` 恒为 true——没发出去一律以错误上浮；`snapshotId` 是这次递出去的哪一版）
   * @throws `QUOTA_EXCEEDED`（日额度到量，带剩余额度）、`CONSENT_REQUIRED`（该平台还没签过风险确认，
   *         此时不进审批、不碰页面、不落账）、`OUTBOUND_APPROVAL_DENIED`（被拒或超时，
   *         此时页面动作次数为零、不落账不扣额度）、`DELIVER_TARGET_OFFLINE`（页面说这个岗位不收了）、
   *         `OUTBOUND_NOT_DELIVERED`（页面回读没确认，此时不落账）、
   *         `WORKFLOW_STEP_FAILED`（等待期间工作流让出）、
   *         `OUTBOUND_CHANNEL_MISSING`（stage 之后适配器被摘掉）
   */
  commit = async (staged: StagedDelivery, signal?: AbortSignal): Promise<DeliverReceiptView> => {
    const { platform, jobId, workflowRunId, nowMs, source, snapshotId, attachment } = staged;

    // 风险确认在闸门之前（spec 2.7-06）：没签过字的人不该先看到「额度不足」，
    // 更不该在 `semi` 档被拉起一张确认卡片——那张卡片问的是「要不要递」，不是「要不要承担风险」。
    consentGateOf(this.ctx).ensureConsent(platform);

    // 到量即在等待之前停（spec 2.6 的同条判据）。留痕由闸门的 `enforce` 负责：
    // 被拒要进 `usage_denials`（spec 5.3-12），编排层自己比对 `check` 就把那条性质漏掉了。
    this.gate.enforce(DELIVER_ACTION, { targetId: jobId, workflowRunId, nowMs });

    // 频控的钟是账本里最近一条 deliver，与打招呼各数各的间隔（两套动作互不背锅）。
    const gap = asApp(this.ctx)['outbound.throttle'].nextGapMs();
    const lastSentAt = this.ledger.latestActionTs(DELIVER_ACTION);
    let waitedMs = 0;
    if (lastSentAt !== null) {
      const remaining = lastSentAt + gap - nowMs;
      if (remaining > 0) {
        await sleep(remaining, signal);
        waitedMs = remaining;
      }
    }
    // 让出检查点必须落在**发送之前**（spec 2.4-07）：`sleep` 在 abort 时是正常返回的，
    // 不在这里问一句，被暂停的那一步仍会把简历递出去。
    assertNotYielded(signal, 'outbound.deliver', '投递简历');

    if (this.config.autonomy !== 'auto') {
      await this.awaitApproval(staged, waitedMs, signal);
    }

    // 审批可能等了很久，渠道到这一刻才最后确认一次：中间适配器被摘掉过就要以「没有渠道」失败，
    // 而不是拿一只已销毁的实例往页面上点。
    const channel: ResumeDeliveryChannel | null = deliverChannelsOf(this.ctx)?.deliverChannel(platform) ?? null;
    if (!channel) {
      throw new AppError('OUTBOUND_CHANNEL_MISSING', `平台 ${platform} 现在没有可用的投递渠道`, 'outbound.deliver', {
        platform,
      });
    }

    const { value, ledgerId } = await this.gate.perform(
      DELIVER_ACTION,
      { targetId: jobId, workflowRunId, nowMs: nowMs + waitedMs, source },
      async () => {
        const outcome = await channel.send(jobId, attachment);
        // 页面没确认递出去就不该有账：闸门只在 task 成功后落账，抛在这里正好复用那条性质（spec 2.6-03）。
        if (!outcome.sent) {
          throw new AppError('OUTBOUND_NOT_DELIVERED', outcome.reason, 'outbound.deliver', { jobId });
        }
        return outcome.reason;
      },
    );
    // 落账之后立刻记一条经过（spec 3.7-02）：与账本行同一个 `ts` 基准、以 `ledgerId` 为主键一一对齐，
    // 于是「这份简历投给了哪个 JD、当时是哪一版」在库里问得出，而账本仍然只数额度。
    this.deliveryRecords.record({ ledgerId, platform, jobId, snapshotId, ts: nowMs + waitedMs });
    this.ctx.logger.info(
      `简历已投递并落账：目标 ${jobId} · 文件 ${attachment.fileName}（${String(attachment.sizeBytes)} 字节）· 等待 ${String(waitedMs)}ms · 来源 ${source} · 账本行 ${String(ledgerId)} · 快照 ${snapshotId ?? '（请求未带快照引用）'}`,
    );
    return {
      platform,
      jobId,
      title: staged.title,
      company: staged.company,
      attachment: attachmentView(attachment),
      reason: value,
      ledgerId,
      waitedMs,
      source,
      snapshotId,
      committed: true,
    };
  };

  /**
   * 投递的唯一入口：`stage` + 按档位决定要不要 `commit`（spec 2.6-01 / 06）。
   * @param raw 请求，同 `stage`
   * @param signal 让出信号，透传给 `commit`
   * @returns 回执；档位为 `suggest` 时 `committed:false`、`ledgerId:null`，**账本一行都不增**
   * @throws 同 `stage` 与 `commit`；`semi` 档等人确认期间的三种定局见 `commit`
   */
  perform = async (raw: unknown, signal?: AbortSignal): Promise<DeliverReceiptView> => {
    const staged = this.stage(raw);
    if (this.config.autonomy === 'suggest') {
      // 「仅辅助」的意思就是到此为止：界面上摆出要递什么，那一下由用户自己点（spec 2.6-06）。
      return {
        platform: staged.platform,
        jobId: staged.jobId,
        title: staged.title,
        company: staged.company,
        attachment: attachmentView(staged.attachment),
        reason: `档位 suggest：已备好 ${staged.attachment.fileName}，未发送`,
        ledgerId: null,
        waitedMs: 0,
        source: staged.source,
        snapshotId: staged.snapshotId,
        committed: false,
      };
    }
    return this.commit(staged, signal);
  };

  /**
   * 当前在等的确认单（spec 2.6-01 的「刷新面板不丢」半边）。
   *
   * 界面每次重渲染都现读一遍，而不是靠订阅事件补齐状态：事件只负责「此刻提醒一下」，
   * 这份读数负责「错过了也还在」。
   * @returns 按申请顺序的待确认单；一张都没有是空数组
   */
  pending = (): DeliverApprovalView[] => this.approvals.pending().map(approvalView);

  /**
   * 界面上那两个按钮打到这里（spec 2.6-01）。
   * @param approvalId 确认单 id，来自 `pending()` 或 `outbound/approval-requested` 事件
   * @param approved 用户是否点了确认
   * @returns 这张单子的岗位与文件三要素，让界面把「批了哪一份」画进结果卡片，不必自己缓存
   * @throws `APPROVAL_NOT_FOUND`——单子不存在（已定局、已超时，或服务在等待期间被重建过）。
   *         这里是 fail-closed：查不到就报结构化失败，绝不因为「找不到对应的那份」而放行任何一次投递。
   *         「id 存在但已经被定过一次」走的是同一条：那张单子已经不算数了，与查无此单对人而言是同一句话
   */
  resolveApproval = (approvalId: string, approved: boolean): DeliverApprovalView => {
    const waiting = this.approvals.pending().find((request) => request.requestId === approvalId);
    if (!waiting || !this.approvals.answer(approvalId, approved)) {
      throw new AppError('APPROVAL_NOT_FOUND', `确认单 ${approvalId} 已经不在等待中`, 'outbound.deliver', {
        approvalId,
        pending: this.approvals.pendingIds(),
      });
    }
    return approvalView(waiting);
  };

  /**
   * 挂起等人确认，并把这张单子登记进 `pending()`。
   *
   * 单号、登记表、超时定时器、让出监听、只生效一次这些**机制**都在 `PendingChannel` 里；
   * 这里只负责把三种定局翻译成投递域的三句话。
   * @param staged 待投递读数
   * @param waitedMs 为满足频控已经等了多久——只为了把确认单的展示时间算准，不参与任何判据
   * @param signal 让出信号：暂停要能立刻打断等待，且**不发送、不落账**（与打招呼的让出语义逐字一致）
   * @returns 确认通过时正常返回；被拒、超时或让出时以结构化错误抛出
   * @throws `OUTBOUND_APPROVAL_DENIED`（拒绝、超时、服务被重建）、`WORKFLOW_STEP_FAILED`（让出）
   */
  private async awaitApproval(staged: StagedDelivery, waitedMs: number, signal?: AbortSignal): Promise<void> {
    const timeoutMs = this.config.approveTimeoutMs;
    const ticket = this.approvals.open(
      {
        platform: staged.platform,
        jobId: staged.jobId,
        title: staged.title,
        company: staged.company,
        attachment: attachmentView(staged.attachment),
      },
      { timeoutMs, signal },
    );
    // 先登记再发事件：界面收到提醒后立刻 `pending()` 也必须能读回这张单子（spec 2.6-01）。
    // 通道在 `open()` 返回之前就已经把它登记上了，所以这句话的顺序由类型保证，不需要额外判据。
    this.ctx.emit('outbound/approval-requested', approvalView(ticket.request));
    this.ctx.logger.info(
      `等待投递确认：单 ${ticket.request.requestId} · 目标 ${staged.jobId} · 文件 ${staged.attachment.fileName} · 频控已等待 ${String(waitedMs)}ms`,
    );
    const outcome = await ticket.outcome;
    // 只有「人点了是」这一种定局放行；其余三条分支每一句都带「未投递」，与 §8 第 3 条的取向一致。
    if (outcome.kind === 'answered' && outcome.answer) return;
    if (outcome.kind === 'answered') {
      throw new AppError(
        'OUTBOUND_APPROVAL_DENIED',
        `未投递：用户在确认卡片上点了拒绝（目标 ${staged.jobId}）`,
        'outbound.deliver',
        { approvalId: ticket.request.requestId, jobId: staged.jobId },
      );
    }
    if (outcome.kind === 'timed-out') {
      throw new AppError(
        'OUTBOUND_APPROVAL_DENIED',
        `未投递：等待确认超过 ${String(timeoutMs)}ms，按拒绝处理`,
        'outbound.deliver',
        { approvalId: ticket.request.requestId, jobId: staged.jobId },
      );
    }
    // `cancelled` 有两种来路且给用户的处置不同，所以不并成一句话：让出（人按了暂停）与等待方自己消失
    // （服务被热改配置重建）。后者原来的文案是「用户在确认卡片上点了拒绝」，那是句假话——没人点过任何东西。
    if (signal?.aborted) {
      throw new AppError('WORKFLOW_STEP_FAILED', '工作流已让出，投递等待中止，未发送', 'outbound.deliver', {
        jobId: staged.jobId,
      });
    }
    throw new AppError(
      'OUTBOUND_APPROVAL_DENIED',
      '未投递：投递服务在这一次等待期间被重建，等待已按「未获批准」收掉',
      'outbound.deliver',
      { approvalId: ticket.request.requestId, jobId: staged.jobId },
    );
  }

  /**
   * 作为工作流节点（`kind: resume.deliver`）时的执行函数。
   *
   * 参数名按计划口径读：`platform`/`job` 定位目标，`file` 是简历路径（省略则用配置的 `resumeFile`），
   * `title`/`company` 只进确认卡片，`snapshot` 是这一版简历的快照 id（省略则经过里不记引用）。
   * 节点声明要 `effect: 'outbound'` + `retryTimes: 0`
   * （spec 2.6-07 的「已下架就不再试」正是靠后者落的，plan §13.4 第 3 条）。
   * @param invocation 节点执行输入：`runId` 参与幂等键，参数从 `spec.params` 来，让出信号从 `signal` 来
   * @throws 缺 `platform` 或 `job` 时 `INVALID_ARGUMENT`；其余失败语义同 `perform`
   */
  executeNode: WorkflowNodeExecutor = async ({ runId, spec, signal }) => {
    const platform = paramString(spec.params.platform);
    const jobId = paramString(spec.params.job);
    if (!platform || !jobId) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `节点 ${spec.id} 缺少参数${!platform ? ' platform' : ''}${!jobId ? ' job' : ''}，不知道该把简历递给谁`,
        DELIVER_NODE_KIND,
        { nodeId: spec.id },
      );
    }
    const request: DeliverRequestView = {
      platform,
      jobId,
      filePath: paramString(spec.params.file) ?? undefined,
      title: paramString(spec.params.title) ?? undefined,
      company: paramString(spec.params.company) ?? undefined,
      // 快照引用与界面入口同口径（spec 3.7-02）：节点不带给经过就是 null，两个入口不会各记一半。
      snapshotId: paramString(spec.params.snapshot) ?? undefined,
      workflowRunId: runId,
    };
    const receipt = await this.perform(request, signal);
    if (!receipt.committed) {
      // 档位是 suggest 时节点**不能算这一步成功**：这一步什么都没做，记成完成就等于把
      // 「只准备」悄悄变成了「已投递」，断点续跑也就不会再回来跑它。
      throw new AppError(
        'OUTBOUND_APPROVAL_DENIED',
        `档位 suggest 不执行投递节点 ${spec.id}：只准备未发送（用界面上的确认卡片手动完成）`,
        DELIVER_NODE_KIND,
        { nodeId: spec.id },
      );
    }
  };

  /**
   * 定下这次投递要用哪份简历文件，并如实声明「没有按岗位定制」（spec 2.8-07 的占位格）。
   *
   * 与 `stage` 走同一条路径解析（`resolveResumePath`），所以这里报出来的文件与真正递出去的是同一份；
   * 不读页面、不碰闸门、不落账、不写文件（`effect: 'read'` 因此是实话）。
   * @param input.platform 平台标识（只用于把读数说完整）
   * @param input.jobId 目标岗位标识
   * @param input.filePath 显式指定的简历路径；省略时取配置 `resumeFile`
   * @returns 简历文件读数 + `customized: false`
   * @throws 平台或岗位没给、两个来源都没给路径、那个文件读不出来时都是 `INVALID_ARGUMENT`
   */
  customize = (input: { platform: string; jobId: string; filePath?: string }): ResumeCustomizeView => {
    if (!input.platform || !input.jobId) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `简历定制必须给出平台与目标岗位，现在${!input.platform ? '缺平台' : '缺岗位'}`,
        CUSTOMIZE_NODE_KIND,
        { jobId: input.jobId },
      );
    }
    const filePath = this.resolveResumePath(input.filePath, input.jobId);
    let bytes: number;
    try {
      bytes = statSync(filePath).size;
    } catch {
      // 配置指到不存在的文件是装配期就会踩到的真缺陷：这里说得出一句人话，比让投递那一步
      // 在读附件时才炸要早一步（spec 2.6-06 的「准备工作里就失败」同口径）。
      throw new AppError('INVALID_ARGUMENT', `简历文件读不出来：${path.basename(filePath)}`, CUSTOMIZE_NODE_KIND, {
        jobId: input.jobId,
      });
    }
    return {
      platform: input.platform,
      jobId: input.jobId,
      filePath,
      fileName: path.basename(filePath),
      bytes,
      customized: false,
    };
  };

  /**
   * 作为工作流节点（`kind: resume.customize`）时的执行函数——P2 这一格是**占位**。
   *
   * 参数与投递节点同口径（`platform` / `job`，可选 `file`），跑完只留一条日志与一个读数：
   * 它不改简历正文，所以后面那格 `resume.deliver` 递的是同一份文件（plan §15.9 决策 2）。
   * @param invocation 节点执行输入：这一步不外发，所以只取 `spec.params`，不看 `signal`
   * @throws 缺 `platform`/`job`、没有可定下来的文件、文件读不出时 `INVALID_ARGUMENT`
   */
  executeCustomizeNode: WorkflowNodeExecutor = ({ spec }) => {
    const view = this.customize({
      platform: paramString(spec.params.platform) ?? '',
      jobId: paramString(spec.params.job) ?? '',
      filePath: paramString(spec.params.file) ?? undefined,
    });
    this.ctx.logger.info(
      `简历定制（P2 占位）：岗位 ${view.jobId} · 文件 ${view.fileName} · ${String(view.bytes)} 字节 · 未按岗位改一字（生成轨属 P3）`,
    );
    // 定文件是同步的（读文件系统的 stat），但执行器契约要求返回 Promise——runner 的退避与让出都按异步编排。
    return Promise.resolve();
  };

  [Service.init](): void {
    // 登记处是可选依赖：工作流没装时投递照样能从界面单次触发，只是没有节点可跑。
    const registry = executorRegistryOf(this.ctx);
    if (registry) {
      registry.register(DELIVER_NODE_KIND, this.executeNode);
      registry.register(CUSTOMIZE_NODE_KIND, this.executeCustomizeNode);
      // 卸载时摘回登记：留下指向已销毁实例的函数，下一次跑工作流会得到无法解释的错误。
      this.ctx.effect(() => () => {
        registry.unregister(DELIVER_NODE_KIND);
        registry.unregister(CUSTOMIZE_NODE_KIND);
      });
    }
    // 服务被重建（改配置热改）时，上一份登记表里悬着的等待必须自己收掉：那些 await 的调用方
    // 已经跟着旧实例一起没了，让它们带着 timer 悬在事件循环里就是「重建即悬挂」（plan §13.3 第 2 条）。
    // 收掉的定局是 `cancelled` 而不是放行——「我这边不等了」从来不是任何人同意了（AGENTS.md §8 第 3 条）。
    this.ctx.effect(() => () => this.approvals.cancelAll());
    // 投递的闸门、审批与落账都在 `perform` 内部（`deliver.ts:308` / `:310` / `:348`），工具层只转发。
    // 入参不含 `workflowRunId`：那是工作流侧的归属字段，从对话入口发起的一次投递本就不属于任何 run。
    const tools = registerAgentTools(this.ctx, [
      agentTool({
        id: 'outbound.deliver.perform',
        titleKey: 'agent.tool.labels.deliverPerform',
        description: '向指定岗位投递简历附件，经闸门判定并按审批档位落一条 deliver 账',
        input: z.strictObject({
          request: z.strictObject({
            platform: z.string().min(1),
            jobId: z.string().min(1),
            filePath: z.string().min(1).optional(),
            title: z.string().min(1).optional(),
            company: z.string().min(1).optional(),
          }),
        }),
        effect: 'outbound',
        requiresConfirmation: true,
        // 沉淀条款（spec 5.4-03，同 `outbound.greet.perform` 的口径：字面量 kind + 点路径参数）。
        // `file` 敢带上是因为执行器把它当**可选**（`paramsString(spec.params.file) ?? 配置的 resumeFile`）：
        // 这一次真跑用的就是记录里那个路径，沉淀下来复现的是同一件事；省略它则回到"每次递配置里那份"。
        // `snapshot` 不在条款里：它是这一版快照的临时身份，沉淀成常量就是把一次性的东西钉进计划（§2.6）。
        workflow: {
          kind: 'resume.deliver',
          target: 'request.jobId',
          params: {
            platform: 'request.platform',
            job: 'request.jobId',
            file: 'request.filePath',
            title: 'request.title',
            company: 'request.company',
          },
        },
        // `committed` 决定措辞：suggest 档只暂存，摘要说成「已投递」就是掩盖（5.1-11 的同一条判据）。
        // `ledgerId` / `snapshotId` 为 null 时不硬凑引用——空着是实话，凑出来的是假证据。
        run: async ({ request }) => {
          const receipt = await this.perform(request);
          return toolResult(receipt, {
            summary:
              `岗位 ${receipt.jobId} 的简历投递${receipt.committed ? '已发出' : '只暂存未发送（按当前审批档位）'}` +
              (receipt.ledgerId === null ? '' : `，账本第 ${String(receipt.ledgerId)} 行`) +
              ` · 附件 ${receipt.attachment.fileName}`,
            evidenceRefs: [
              `job:${receipt.platform}/${receipt.jobId}`,
              ...(receipt.ledgerId === null ? [] : [`ledger:${String(receipt.ledgerId)}`]),
              ...(receipt.snapshotId === null ? [] : [`snapshot:${receipt.snapshotId}`]),
            ],
          });
        },
      }),
    ]);
    const deliverable = deliverChannelsOf(this.ctx)?.deliverablePlatforms() ?? [];
    this.ctx.logger.info(
      `投递编排就绪：额度键 ${DELIVER_ACTION} · 档位 ${this.config.autonomy} · 确认超时 ${String(this.config.approveTimeoutMs)}ms · 当前可投递平台 ${deliverable.join(' / ') || '（平台层尚未登记带 sendResume 的适配器）'} · 节点执行器${registry ? `已登记 ${DELIVER_NODE_KIND} / ${CUSTOMIZE_NODE_KIND}` : '未登记（工作流未挂载）'} · agent 工具登记 ${String(tools)} 个${tools === 0 ? '（注册表未挂载）' : ''}`,
    );
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'outbound.deliver': OutboundDeliverService;
  }
}
