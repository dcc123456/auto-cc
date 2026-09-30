/**
 * `PlatformAdapter` 契约与**站点知识包**的形状（spec 2.2-06 / 2.2-08）。
 *
 * 为什么契约放在内核侧而不是平台包里：plan §3 规则 1 规定 `browser` 不认识 BOSS，
 * 平台知识只能**被注册进来**。那么「注册进来的东西长什么样」就必须定义在被认识的那一侧，
 * 否则每个平台包各自解释一遍接口，`workflow` 就只能对着一堆互不兼容的形状写分支。
 *
 * 知识包与代码分离是这条契约的另一半：定位声明（含 CSS / XPath 字面量）、字段顺序、
 * 频控参数**全部是数据**。站点改版改的是数据，适配器代码不动——这也是 2.2-08 能被机检的原因
 * （`scripts/check-knowledge-pack.ts` 扫的就是「适配器源码里不许出现选择器字面量」）。
 */
import { AppError } from '@auto-cc/core';
import type { PlatformMetaView } from '@auto-cc/shared';
import { z } from 'zod';
import { validateSpec } from './locator-spec.js';

/** 定位声明的线格式：与 `shared` 的 `LocateSpec` 同构，用于校验外部 JSON（知识包是不可信输入）。 */
const locateCandidateSchema = z.strictObject({
  strategy: z.enum(['testId', 'id', 'name', 'role', 'text', 'css', 'xpath', 'fingerprint']),
  value: z.string().min(1).optional(),
  attribute: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  exact: z.boolean().optional(),
});

const locateSpecSchema = z.strictObject({
  description: z.string().min(1),
  cardinality: z.enum(['single', 'many']),
  candidates: z.array(locateCandidateSchema).min(1),
});

/** 站点知识包：平台自己声明的「页面长什么样、动作怎么打、节奏怎么控」。 */
export const knowledgePackSchema = z.strictObject({
  platform: z.string().regex(/^[a-z][a-z0-9-]*$/, '平台标识要用小写字母开头的短名'),
  displayName: z.string().min(1),
  startUrl: z.url(),
  capabilities: z.array(z.enum(['search', 'detail', 'chat', 'sendResume', 'readReplies'])).min(1),
  /** 语义名 → 定位声明。适配器只按语义名取用，源码里不出现任何选择器。 */
  locators: z.record(z.string().min(1), locateSpecSchema),
  /** 抓取字段的声明顺序：列表页字段顺序变了也只改这份数据。 */
  fieldOrder: z.array(z.string().min(1)).default([]),
  pacing: z
    .strictObject({
      /** 两次外发动作之间的最小间隔（毫秒），2.5 的节流读这里。 */
      minActionGapMs: z.number().int().min(0).max(600_000).default(3_000),
      /** 单个平台每日外发上限，与 `entitlement.gate` 的额度是两套独立限制。 */
      maxDailyActions: z.number().int().min(1).max(1_000).default(20),
    })
    .default({ minActionGapMs: 3_000, maxDailyActions: 20 }),
});

/** 校验后的知识包形状。 */
export type KnowledgePack = z.output<typeof knowledgePackSchema>;

/**
 * 校验一份知识包：结构过 zod，再逐条跑定位声明的语义校验。
 * @param raw 从 JSON 读出来的未知值（外部数据，一律视为不可信）
 * @returns 校验通过的知识包
 * @throws 结构或声明非法时 `KNOWLEDGE_PACK_INVALID`，`details.problems` 逐条指出是哪一层的哪一条
 */
export function parseKnowledgePack(raw: unknown): KnowledgePack {
  const parsed = knowledgePackSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError('KNOWLEDGE_PACK_INVALID', '站点知识包结构不合法', 'platform.contract', {
      problems: parsed.error.issues.map((issue) => `${issue.path.join('.')}：${issue.message}`),
    });
  }
  const problems: string[] = [];
  for (const [name, spec] of Object.entries(parsed.data.locators)) {
    for (const problem of validateSpec(spec)) problems.push(`${name}：${problem}`);
  }
  if (problems.length > 0) {
    throw new AppError(
      'KNOWLEDGE_PACK_INVALID',
      `站点知识包里的定位声明不可用：${problems.join('；')}`,
      'platform.contract',
      {
        problems,
      },
    );
  }
  return parsed.data;
}

/** 一次 JD 搜索的输入条件。 */
export type JobSearchCriteria = {
  /** 关键词（职位名、技能名） */
  keyword: string;
  /** 城市名；省略表示用平台的默认定位 */
  city?: string;
  /** 本次最多取回几条（适配器内部仍受知识包 `pacing` 与额度闸门约束） */
  limit?: number;
};

/** 列表页上的一条 JD 摘要。 */
export type JobSummary = {
  platform: string;
  /** 平台侧的岗位标识；没有就用详情页地址派生，保证同一岗位在库里只有一行 */
  jobId: string;
  title: string;
  company: string;
  /** 薪资原文（「15-25K·14薪」），归一化留给 2.3，不在这里丢信息 */
  salaryText: string;
  city: string;
  detailUrl: string;
  capturedAt: number;
};

/** 详情页读出的岗位详情。 */
export type JobDetail = {
  summary: JobSummary;
  description: string;
  requirements: string[];
};

/** 一次外发（打招呼 / 发简历）的结局。 */
export type OutboundResult = {
  /** 页面是否真的把动作做完（回读到成功态才算 true） */
  sent: boolean;
  /** 失败原因或风控提示；`sent` 为 true 时说明是哪一步确认的 */
  reason: string;
  /** 计量凭证：外发必经 `entitlement.gate`，回执里带回本次扣的额度键 */
  ledgerKey: string | null;
};

/** 会话里读到的一条回复。 */
export type ReplyMessage = {
  platform: string;
  jobId: string;
  /** 发送方角色：招聘者或求职者自己 */
  from: 'recruiter' | 'self';
  text: string;
  at: number;
};

/**
 * 平台适配器契约：五个动作 + 一份自我声明。
 *
 * 契约里**没有任何选择器**，也没有 `webContents`：适配器只会说「我要点 `greetButton`」，
 * 具体在页面哪个位置、用哪条通道，全由 `browser.locate` / `browser.act` 决定（plan §3 规则 3）。
 */
export interface PlatformAdapter {
  /** 平台自我声明（界面与 `platform.registry.list` 都读这份） */
  readonly meta: PlatformMetaView;
  /**
   * 按条件搜索岗位列表。
   * @param criteria 搜索条件
   * @returns 摘要列表，顺序即页面呈现顺序
   */
  search(criteria: JobSearchCriteria): Promise<JobSummary[]>;
  /**
   * 读取一个岗位的详情。
   * @param jobId 平台侧岗位标识
   * @returns 详情；页面结构读不出时以结构化错误失败，不返回半空对象
   */
  detail(jobId: string): Promise<JobDetail>;
  /**
   * 打招呼 / 发送一段话术（外发动作，必经额度闸门）。
   * @param jobId 目标岗位
   * @param text 话术正文
   * @returns 外发结局
   */
  chat(jobId: string, text: string): Promise<OutboundResult>;
  /**
   * 发送简历附件（外发动作，必经额度闸门）。
   * @param jobId 目标岗位
   * @returns 外发结局
   */
  sendResume(jobId: string): Promise<OutboundResult>;
  /**
   * 读取会话里的新回复。
   * @param jobId 目标岗位
   * @returns 按时间升序的回复列表
   */
  readReplies(jobId: string): Promise<ReplyMessage[]>;
}
