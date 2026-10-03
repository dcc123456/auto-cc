/**
 * `agent.run`：一只按引用回看的口（spec 5.7-02 / plan §7.5.7 决策十一）。
 *
 * 对话卡片上的每一条证据引用（`ledger:12`、`job:boss/123`、`entity:ent-3`…）过去只是裸文本，
 * 人看得见引用、点不进读数。判据要的是「每一步都能回溯」，而回溯需要的是**一只**口：
 * 若每种前缀各开一只 IPC 口、让界面去分派，界面就得知道「哪条引用归谁管」——那是把主进程的路由表
 * 抄第二份（AGENTS.md §2.5），而循环合成的那类引用（正文压根没落盘）还会被界面凑出一个空视图来。
 * 所以这里按前缀**现问**归属服务（`maybeService`，§9 的 2.5-e 实测：热改配置会重建下游，
 * 在本地存第二份引用表就会静默变空），把读到的东西投影成统一视图 `EvidenceRefView`；
 * **读不到也返回一条确定结局**（`unavailableReason`）而不抛——今天的缺口本身就是要给人在屏幕上看懂的读数。
 *
 * 三条刻意的取舍，都写在这里而不是散在各分支的注释里：
 * ① 本包不 import 任何能力包（spec 5.1-08 / §5.9，eslint 机检），归属服务的读数因此按**结构接口**取：
 *    只声明路由要用的那几位，两边各自演进时是编译期断而不是静默错读（`WorkflowPlanSaver` 同套路）。
 *    跨进程的 DTO（`LedgerRowView` / `JobRowView`）住在 `@auto-cc/shared`，那边直接引，不再镜像一遍。
 * ② 正文只给「这条记录是什么」那几行，不搬整份简历：工作副本与快照的全文各有自己的视图
 *    （简历编辑页 / 快照 diff），这里再搬一遍就是第二条读取通道（§2.7），还会把手机号、邮箱这类
 *    个人数据抄进对话流水与验收截图（§8.5）。
 * ③ 这只口**不登记为 agent 工具**：它是人回看用的读数口。模型不需要「按引用读别人的记录」的手，
 *    与 `agent.loop.confirm` / `agent.pause.respond` 那一类「只由人按」的口同一口径
 *    （静态那半边由 `scripts/check-agent-model-authority.ts` 的清单钉住）。
 */
import { Service, asApp, maybeService, type AgentRunView, type Context, type EvidenceRefView } from '@auto-cc/core';
import type { JobRowView, LedgerRowView } from '@auto-cc/shared';
import { z } from 'zod';
import type { AgentLoopService } from './loop.js';

/** 无可调项：路由表与拒因文案都是代码性质，不是配置（配置内联进代码就是 4.x 起禁的那类魔法数反面）。 */
export const agentEvidenceSchema = z.strictObject({});

/** 校验后的配置形状（调用点与测试引用它，而不是手写一遍 zod 推断）。 */
export type AgentEvidenceConfig = z.output<typeof agentEvidenceSchema>;

/** `resume.doc.load()` 里路由要用的那几位（工作副本的完整正文仍只经 `load` 这一条通道读）。 */
type WorkingCopyReading =
  | {
      readonly status: 'found';
      readonly document: {
        readonly id: string;
        readonly profile: { readonly name: string };
        readonly sections: readonly { readonly title: string; readonly entries: readonly unknown[] }[];
        readonly metrics: { readonly pages: number };
        readonly updatedAt: number;
      };
    }
  | { readonly status: 'missing' }
  | { readonly status: 'corrupt'; readonly reason: string };

/** `resume.parse.importOf()` 里路由要用的那几位（`issues` 只取展示用的两位）。 */
type ImportReading = {
  readonly docId: string;
  readonly sourceHash: string;
  readonly format: string;
  readonly status: string;
  readonly textLength: number;
  readonly updatedAt: number;
  readonly issues: readonly { readonly code: string; readonly sectionKind: string | null; readonly excerpt: string }[];
};

/** `resume.generate.receiptOf()` 里路由要用的那几位。 */
type GenerationReading = {
  readonly id: string;
  readonly docId: string;
  readonly jdId: string | null;
  readonly createdAt: number;
  readonly promptVersion: string | null;
  readonly model: string | null;
  readonly modelStatus: string;
  readonly outcome: string;
  readonly retried: boolean;
  readonly evidenceIds: readonly string[];
  readonly violations: readonly string[];
};

/** `kb.profile.evidenceBody()` 里路由要用的那几位（正文拼装规则只在那一处，这里不重拼）。 */
type EvidenceBodyReading = {
  readonly id: string;
  readonly origin: string;
  readonly text: string;
  readonly sourceDocId: string | null;
};

/** `resume.snapshot.meta()` 里路由要用的那几位（快照正文仍只经 `restore` 那条恢复通道读）。 */
type SnapshotMetaReading = {
  readonly snapshotId: string;
  readonly docId: string;
  readonly templateId: string;
  readonly fontSet: string;
  readonly hash: string;
  readonly createdAt: number;
};

/** 归属服务的最小接口：只声明本路由会按的那一只手。 */
type LedgerReader = { row(id: number): LedgerRowView | null };
type JdStoreReader = { detail(jobId: string, platform?: string): JobRowView | null };
type DocReader = { load(id: string): WorkingCopyReading };
type ImportReader = { importOf(sourceHash: string): ImportReading | null };
type GenerationReader = { receiptOf(receiptId: string): GenerationReading | null };
type ProfileReader = { evidenceBody(id: string): EvidenceBodyReading | null };
type SnapshotReader = { meta(snapshotId: string): SnapshotMetaReading | null };

/** 一次待确认条目的展示上限（超出只说「另 N 条」，界面上那张清单才是全文）。 */
const ISSUE_DISPLAY_LIMIT = 5;

/**
 * 取引用前缀（路由表的键）。
 * @param ref 引用原文
 * @returns 第一个 `:` 之前的部分；没有分隔符时原样返回（调用方据此走「不认识」那一支）
 */
function kindOf(ref: string): string {
  const separator = ref.indexOf(':');
  return separator < 0 ? ref : ref.slice(0, separator);
}

/**
 * 取引用里的那把键（前缀之后的整段，含 `job:boss/123` 里的斜杠）。
 * @param ref 引用原文
 * @returns 键原文；没有前缀分隔符时返回空串（算「这条引用没有 id」）
 */
function keyOf(ref: string): string {
  const separator = ref.indexOf(':');
  return separator < 0 ? '' : ref.slice(separator + 1);
}

/**
 * 组装「读到正文」那一面的读数（唯一的组装处，§2.2）。
 * @param ref 引用原文
 * @param kind 前缀
 * @param title 标题行（主进程按归属服务的字段拼，是**内容**不是界面文案）
 * @param body 正文读数
 * @param at 归属记录的时刻（毫秒）；没有时刻的记录给 null
 * @returns 三项结局里的「读到」那一份，`unavailableReason` 恒为 null
 */
function readBack(ref: string, kind: string, title: string, body: string, at: number | null): EvidenceRefView {
  return { ref, kind, title, body, unavailableReason: null, at };
}

/**
 * 组装「读不到」那一面的读数（与 `readBack` 同为唯一组装处）。
 * @param ref 引用原文
 * @param kind 前缀
 * @param reason 为什么读不到——三种缺口各有各的话，不许混成一句「读不到」
 * @param at 引用本身带着的时刻（`…@<毫秒>`）；不是从库里读出来的，所以缺口面也可以有
 * @returns 三项结局里的「说明原因」那一份，`title` / `body` 恒为 null
 */
function unreadBack(ref: string, kind: string, reason: string, at: number | null = null): EvidenceRefView {
  return { ref, kind, title: null, body: null, unavailableReason: reason, at };
}

/**
 * 把 `…@<毫秒>` 尾巴上的时刻读成一个数（引用里就写着的事实）。
 * @param key `snapshot:` 之后那一段
 * @returns 时刻毫秒；尾巴上没有纯数字时 null（不猜）
 */
function momentOf(key: string): number | null {
  const separator = key.lastIndexOf('@');
  if (separator < 0) return null;
  const tail = key.slice(separator + 1);
  return /^\d+$/.test(tail) ? Number(tail) : null;
}

/**
 * 按引用回看的那一只手所属的服务（spec 5.7-02）。
 *
 * 挂载与生命周期：它自己不建表、不占迁移号段，也不写任何东西——整只手只读。
 * `agent.loop` 是硬依赖（同包内，与 `agent.sediment` 同形），因为「这条引用真属于这一步吗」
 * 这个判据只有 run/步记录那一份投影能给；其余归属服务一律 `maybeService` 现问。
 */
export class EvidenceRefService extends Service {
  static provide = 'agent.run';
  static Config = agentEvidenceSchema;
  static inject = ['agent.loop'];

  constructor(ctx: Context, _options: AgentEvidenceConfig) {
    // 无配置项也要接住第二个实参：cordis 递的是校验后的配置对象（AGENTS.md §9 实测 1.3）。
    super(ctx, 'agent.run');
  }

  private get loop(): AgentLoopService {
    return asApp(this.ctx)['agent.loop'];
  }

  /**
   * 按引用回看：把一步上的一条证据引用投影成确定结局的读数。
   *
   * 判序与两条性质：① **先验归属**——这条引用必须确实登记在那条 run 的那一步上，否则不读任何别人的记录；
   * ② **从不抛**——run 查不到、服务没挂载、库里没这一行、这类引用本就不落正文，四种情况一律折成
   * `unavailableReason`，因为「每一步都能回溯」问的是结局确定，不是每条都能读到正文。
   * @param runIdRaw 来自对话卡片的 run id（不可信输入：只用来问 `agent.loop`，不拼 SQL）
   * @param planStepIndexRaw 那一步的下标（不可信输入：非整数或越界一律算「不属于这一步」）
   * @param refRaw 被点的那一条引用原文，与 `AgentStepView.evidenceRefs` 逐字相同
   * @returns 统一视图；`title` / `body` / `unavailableReason` 三者必有其一
   */
  evidence(runIdRaw: string, planStepIndexRaw: number, refRaw: string): EvidenceRefView {
    const ref = typeof refRaw === 'string' ? refRaw.trim() : '';
    const kind = kindOf(ref);
    const ownership = this.ownershipFailure(runIdRaw, planStepIndexRaw, ref, kind);
    if (ownership !== null) return unreadBack(ref, kind, ownership);
    const key = keyOf(ref);
    if (key === '') return unreadBack(ref, kind, '这条引用只有前缀、没有 id，没有可定点读的东西');
    try {
      return this.dispatch(ref, kind, key);
    } catch (error) {
      // 归属服务在自己的库里读挂了（装配被摘掉一块、它依赖的表还没建起来就是现成的一例：
      // `jd.store.detail` 要 JOIN `conversation_messages`，那张表归会话库自己建）。
      // 这只口的契约是**从不抛**——跨进程抛裸异常会丢掉原因，界面上只剩「An error occurred」，
      // 而这里要给人看的正是那句原因（§8.2 的白名单口不猜错误形状，只在边界收成读数）。
      return unreadBack(ref, kind, `归属服务读数失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 按引用前缀分派到归属服务，读那一条记录（`evidence` 的唯一被调体，异常由它收成读数）。
   * @param ref 引用原文
   * @param kind 前缀（路由表的键）
   * @param key 前缀之后的那把键（非空）
   * @returns 三种结局之一：读到正文 / 说清为什么没有正文；归属服务抛错时由调用方接住
   */
  private dispatch(ref: string, kind: string, key: string): EvidenceRefView {
    switch (kind) {
      case 'ledger':
        return this.readLedger(ref, key);
      case 'job':
        return this.readJob(ref, key);
      case 'jd':
        return this.readJd(ref, key);
      case 'doc':
        return this.readDoc(ref, key);
      case 'hash':
        return this.readImport(ref, key);
      case 'generation':
        return this.readGeneration(ref, key);
      case 'entity':
      case 'evidence':
        return this.readKbEvidence(ref, kind, key);
      case 'snapshot':
        return this.readSnapshot(ref, key);
      case 'session':
        return unreadBack(
          ref,
          kind,
          `会话引用记的是「这一步用的是 ${key} 的登录分区」。登录态是现读的，没有随引用落盘的正文——此刻的登录态在「会话」那一页看`,
        );
      case 'search':
        return unreadBack(
          ref,
          kind,
          '搜索引用记的是这一趟抓的入口（平台 / 关键词），它不是一条记录的 id。抓到了哪几条，按逐条的 job 或 jd 引用回看',
        );
      case 'page':
      case 'frame':
        return unreadBack(
          ref,
          kind,
          '页面与帧的引用记的是当时那一刻的地址，DOM 正文没有随引用落盘。失败现场的截图与 DOM 证据是工作流那边按 run + 节点另存的一份',
        );
      default:
        return unreadBack(ref, kind, `路由表里没有「${kind}」这一类引用，不替它编一段读数`);
    }
  }

  /**
   * 这条引用是不是真登记在那一步上（越界与张冠李戴都在这挡掉）。
   * @param runIdRaw 请求带的 run id
   * @param planStepIndexRaw 请求带的步下标
   * @param ref 已去空白的引用原文
   * @param kind 引用前缀（只进拒因文案，帮人看清是哪一步的哪一类引用被挡）
   * @returns 归属成立返回 null；否则返回那句拒因（不抛，与 `evidence` 的「从不抛」同一条性质）
   */
  private ownershipFailure(runIdRaw: string, planStepIndexRaw: number, ref: string, kind: string): string | null {
    if (ref === '') return '这条引用是空的，没有可回看的记录';
    if (!Number.isInteger(planStepIndexRaw) || planStepIndexRaw < 0) {
      return `步下标「${String(planStepIndexRaw)}」不是一个合法的步骤序号`;
    }
    let run: AgentRunView;
    try {
      run = this.loop.read(runIdRaw);
    } catch {
      return `查不到这条 run（${runIdRaw}），因此也无从确认这条引用属于哪一步`;
    }
    const step = run.steps.find((item) => item.planStepIndex === planStepIndexRaw);
    if (step === undefined) {
      return `这条 run 只跑到 ${String(run.steps.map((item) => item.planStepIndex).join('、') || '没有一步')}，第 ${String(planStepIndexRaw)} 步没有落步记录`;
    }
    if (!step.evidenceRefs.includes(ref)) {
      return `第 ${String(planStepIndexRaw)} 步登记的引用（${kind} 类在内共 ${String(step.evidenceRefs.length)} 条）里没有这一条`;
    }
    return null;
  }

  /**
   * 按名字现问归属服务（不在本服务里存第二份事实，§9 的 2.5-e 实测）。
   * @param id 服务的 provide 名
   * @param label 拒因里说人话的名字（用户看得懂的功能名，不是内部 id）
   * @returns 服务实例；没挂载时返回那句确定的拒因（调用方直接当 `unavailableReason` 用）
   */
  private ownerOf<T extends object>(id: string, label: string): T | string {
    const service = maybeService<T>(this.ctx, id);
    return service === undefined ? `${label}（${id}）此刻没有挂载，这条引用无处可问` : service;
  }

  /**
   * 一条外发记账（`ledger:<行 id>`）。
   * @param ref 引用原文
   * @param key 行 id（十进制整数字符串）
   * @returns 读到则给动作与对象，读不到则给「不是行 id」「库里没有这一行」「账本没挂载」三句之一
   */
  private readLedger(ref: string, key: string): EvidenceRefView {
    const kind = 'ledger';
    const owner = this.ownerOf<LedgerReader>('usage.ledger', '用量账本');
    if (typeof owner === 'string') return unreadBack(ref, kind, owner);
    const rowId = Number(key);
    if (!Number.isInteger(rowId) || rowId < 1) {
      return unreadBack(ref, kind, `账本引用的是第「${key}」行，那不是行 id（行 id 是正整数）`);
    }
    const row = owner.row(rowId);
    if (row === null) return unreadBack(ref, kind, `账本里没有第 ${String(rowId)} 行——被闸门拦下的那一次不会进这张表`);
    return readBack(
      ref,
      kind,
      `外发记账 · ${row.action}`,
      [
        `动作：${row.action}`,
        `对象：${row.targetId ?? '未记'}`,
        `工作流 run：${row.workflowRunId ?? '无'}`,
        `记账来源：${row.source ?? '本地记账'}`,
        row.remoteRef === null ? undefined : `外部流水号：${row.remoteRef}`,
      ]
        .filter((line): line is string => line !== undefined)
        .join('\n'),
      row.ts,
    );
  }

  /**
   * 一条岗位记录（`job:<平台>/<岗位 id>`）。
   * @param ref 引用原文
   * @param key 平台与岗位 id，中间一个斜杠
   * @returns 读到则给岗位身份与回复状态，读不到则给「形状不对」「库里没有」「jd 存储没挂载」三句之一
   */
  private readJob(ref: string, key: string): EvidenceRefView {
    const kind = 'job';
    const owner = this.ownerOf<JdStoreReader>('jd.store', '岗位库');
    if (typeof owner === 'string') return unreadBack(ref, kind, owner);
    const separator = key.indexOf('/');
    if (separator < 1 || separator === key.length - 1) {
      return unreadBack(ref, kind, `岗位引用「${key}」不是「平台/岗位 id」的形状`);
    }
    const platform = key.slice(0, separator);
    const jobId = key.slice(separator + 1);
    const row = owner.detail(jobId, platform);
    if (row === null) return unreadBack(ref, kind, `库里没有第 ${platform} 平台的岗位 ${jobId}`);
    return readBack(ref, kind, `${row.title} · ${row.company}`, jobBody(row, platform, jobId), row.capturedAt);
  }

  /**
   * 一条岗位记录但引用里只给了岗位 id（`jd:<岗位 id>`，话术草稿那边 mint 的形状）。
   * @param ref 引用原文
   * @param key 岗位 id
   * @returns 同 `readJob`；跨平台同 id 时取最近抓到的那一行（与 mint 处同一个取舍，不另立规则）
   */
  private readJd(ref: string, key: string): EvidenceRefView {
    const kind = 'jd';
    const owner = this.ownerOf<JdStoreReader>('jd.store', '岗位库');
    if (typeof owner === 'string') return unreadBack(ref, kind, owner);
    const row = owner.detail(key);
    if (row === null) return unreadBack(ref, kind, `库里没有岗位 ${key}`);
    return readBack(ref, kind, `${row.title} · ${row.company}`, jobBody(row, row.platform, key), row.capturedAt);
  }

  /**
   * 一份简历工作副本（`doc:<文档 id>`）——只回结构读数，全文在简历编辑页。
   * @param ref 引用原文
   * @param key 文档 id
   * @returns 三态各有一句：`found` 给区块结构，`missing` 说「导入判为扫描件时不产文档」，`corrupt` 带原话
   */
  private readDoc(ref: string, key: string): EvidenceRefView {
    const kind = 'doc';
    const owner = this.ownerOf<DocReader>('resume.doc', '简历工作副本');
    if (typeof owner === 'string') return unreadBack(ref, kind, owner);
    const reading = owner.load(key);
    if (reading.status === 'missing') {
      return unreadBack(ref, kind, `工作副本里没有文档 ${key} 的正文——导入被判为扫描件时不产文档，或它已被删除`);
    }
    if (reading.status === 'corrupt') {
      return unreadBack(ref, kind, `工作副本读回校验失败：${reading.reason}`);
    }
    const document = reading.document;
    return readBack(
      ref,
      kind,
      `${document.profile.name === '' ? '未填姓名' : document.profile.name} 的简历工作副本`,
      [
        `文档 id：${document.id}`,
        `区块：${String(document.sections.length)} 个 · ${document.sections
          .map((section) => `${section.title}（${String(section.entries.length)} 条）`)
          .join('、')}`,
        `排版页数：${String(document.metrics.pages)}`,
        '完整正文在「简历」那一页看，这里不搬第二份全文',
      ].join('\n'),
      document.updatedAt,
    );
  }

  /**
   * 一条导入记录（`hash:<来源指纹>`）——含待确认清单的前几条。
   * @param ref 引用原文
   * @param key 来源哈希（4.1-07 的幂等键）
   * @returns 读到则给格式 / 状态 / 长度 / 待确认条目，读不到给「库里没有」或「没挂载」
   */
  private readImport(ref: string, key: string): EvidenceRefView {
    const kind = 'hash';
    const owner = this.ownerOf<ImportReader>('resume.parse', '简历导入');
    if (typeof owner === 'string') return unreadBack(ref, kind, owner);
    const record = owner.importOf(key);
    if (record === null) {
      return unreadBack(ref, kind, `导入记录里没有指纹 ${key} 那一条——它可能记在别的库文件里，或那一行已被清理`);
    }
    const shown = record.issues.slice(0, ISSUE_DISPLAY_LIMIT);
    const rest = record.issues.length - shown.length;
    return readBack(
      ref,
      kind,
      `简历导入记录 · ${record.format} · ${record.status}`,
      [
        `文档 id：${record.docId}`,
        `来源指纹：${record.sourceHash}`,
        `正文长度：${String(record.textLength)} 字`,
        `待确认条目：${String(record.issues.length)} 条`,
        ...shown.map((issue) => `· ${issue.code}（${issue.sectionKind ?? '文档级'}）：${issue.excerpt}`),
        rest > 0 ? `…另 ${String(rest)} 条在「知识库 → 待确认」那一页` : undefined,
      ]
        .filter((line): line is string => line !== undefined)
        .join('\n'),
      record.updatedAt,
    );
  }

  /**
   * 一次定向生成（`generation:<回执 id>`）——读库里那一行，不读内存里的提议态。
   * @param ref 引用原文
   * @param key 回执 id
   * @returns 读到则给模型 / 结果 / 依据条目数 / 未通过项；读不到给「库里没有」或「没挂载」
   */
  private readGeneration(ref: string, key: string): EvidenceRefView {
    const kind = 'generation';
    const owner = this.ownerOf<GenerationReader>('resume.generate', '定向生成');
    if (typeof owner === 'string') return unreadBack(ref, kind, owner);
    const record = owner.receiptOf(key);
    if (record === null) return unreadBack(ref, kind, `生成记录里没有回执 ${key} 那一条`);
    return readBack(
      ref,
      kind,
      `定向生成回执 · ${record.outcome}`,
      [
        `文档：${record.docId}｜岗位：${record.jdId ?? '未绑定'}`,
        `模型：${record.model ?? '未记录'}（${record.modelStatus}）· prompt ${record.promptVersion ?? '未记录'}`,
        `是否重试过：${record.retried ? '是' : '否'}`,
        `依据条目：${String(record.evidenceIds.length)} 条`,
        `事实校验未通过项：${record.violations.length === 0 ? '无' : record.violations.join('；')}`,
        '生成的正文当时只进了预览与模型上下文，落库的是这一行记录',
      ].join('\n'),
      record.createdAt,
    );
  }

  /**
   * 一条知识库依据（`entity:<实体 id>` 与 `evidence:<id>` 走同一只手：先实体后切片）。
   * @param ref 引用原文
   * @param kind 引用前缀（原样带进读数，界面据此画外壳）
   * @param key 实体 id 或切片 id
   * @returns 读到则给出处与原文（拼装规则复用 `evidenceBody`，本文件不重拼 payload），读不到给两句之一
   */
  private readKbEvidence(ref: string, kind: string, key: string): EvidenceRefView {
    const owner = this.ownerOf<ProfileReader>('kb.profile', '知识库');
    if (typeof owner === 'string') return unreadBack(ref, kind, owner);
    const body = owner.evidenceBody(key);
    if (body === null) {
      return unreadBack(ref, kind, `知识库里查不到 ${key}（实体与区块切片都试过）——重新建档时旧条目会被替换掉`);
    }
    return readBack(
      ref,
      kind,
      `知识库依据 · ${body.origin}`,
      [`出处：${body.sourceDocId ?? '手工录入（没有来源文档）'}`, body.text].join('\n'),
      null,
    );
  }

  /**
   * 三种形状完全不同的 `snapshot:` 在这里分岔（决策十一点名的那一处）。
   *
   * 带 `@` 的是**时刻**（循环合成的 `snapshot:<手名>@<毫秒>`、定位器留的 `snapshot:<帧地址>@<毫秒>`），
   * 正文只进了当时的上下文，压根没有落盘；不带 `@` 的才是简历快照 id（投递回执那一手，id 是 uuid）。
   * @param ref 引用原文
   * @param key `snapshot:` 之后那一段
   * @returns 时刻类给「记的是时刻不是文件」那句诚实的话（带上引用里的时刻）；
   *          落库类读到则给元数据（模板 / 字体 / 内容指纹），读不到给「库里没有」或「没挂载」
   */
  private readSnapshot(ref: string, key: string): EvidenceRefView {
    const kind = 'snapshot';
    const moment = momentOf(key);
    if (moment !== null) {
      return unreadBack(
        ref,
        kind,
        '这条引用记的是时刻不是文件：那一刻某只手读到的东西只进了当时的上下文，没有随引用落盘',
        moment,
      );
    }
    const owner = this.ownerOf<SnapshotReader>('resume.snapshot', '简历快照');
    if (typeof owner === 'string') return unreadBack(ref, kind, owner);
    const meta = owner.meta(key);
    if (meta === null) {
      return unreadBack(ref, kind, `快照表里没有 ${key} 这一行——投递用的那份快照可能没落库，或已过保留期被清理`);
    }
    return readBack(
      ref,
      kind,
      `简历快照 · ${meta.templateId}`,
      [
        `快照 id：${meta.snapshotId}`,
        `文档：${meta.docId}｜字体集：${meta.fontSet}`,
        `内容指纹：${meta.hash}`,
        '整页效果在「版本与快照」那一页看，这里不搬第二份全文',
      ].join('\n'),
      meta.createdAt,
    );
  }
}

/**
 * 把一条岗位记录拼成正文读数（`job:` 与 `jd:` 两种前缀共用，§2.2 出现第二次就抽）。
 * @param row 岗位行读数
 * @param platform 引用里认得的平台标签（`jd:` 那一支用行自己的值，保持与库里一致）
 * @param jobId 岗位 id
 * @returns 多行文本：身份、薪资、要求条数、回复状态；不写详情页 URL 之外的个人数据
 */
function jobBody(row: JobRowView, platform: string, jobId: string): string {
  return [
    `平台：${platform}｜岗位 id：${jobId}`,
    `薪资：${row.salaryText}`,
    `城市 / 经验 / 学历：${row.city} / ${row.experience} / ${row.education}`,
    `要求条目：${String(row.requirements.length)} 条`,
    `对方是否回过话：${row.replied ? '是' : '否'}（来话 ${String(row.inboundCount)} 条）`,
    `详情页：${row.sourceUrl}`,
  ].join('\n');
}

declare module '@auto-cc/core' {
  interface AppServices {
    'agent.run': EvidenceRefService;
  }
}
