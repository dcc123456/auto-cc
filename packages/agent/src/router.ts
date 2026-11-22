/**
 * 助手的意图路由（spec 10.11-16 / 2026-11-22 裁定）：把一句话分到六类之一。
 *
 * 三条硬边界：
 * 1. **只分类，不判业务**——路由的产出只有 `intent` 与可选的 `target`，任何「能不能做」都由处理器判。
 * 2. **不碰外发**：本文件与六个处理器不许 import 任何 `outbound.*`（`scripts/check-router-no-outbound.ts` 机检守着）。
 * 3. **不哑**：模型不可用 / 超时 / 解析失败时用关键词表回落；表也不中才认「没听懂」。
 */
import { z } from 'zod';
import { ROUTE_PROMPT } from './prompts.js';

/** 六类职责 + 无法分类。 */
export const ROUTE_INTENTS = ['explain', 'navigate', 'summary', 'draft_plan', 'act', 'reminder', 'unknown'] as const;
export type RouteIntent = (typeof ROUTE_INTENTS)[number];

/** 七个工作台的 key（与左轨同一套；跳转目标只许是它们）。 */
export const ROUTE_VIEWS = ['chat', 'jobs', 'resume', 'workflow', 'models', 'trust', 'diagnostics'] as const;
export type RouteView = (typeof ROUTE_VIEWS)[number];

/** 分类结果（模型输出也按这一份 strict 校验，多一个字段就当解析失败）。 */
export const routeSchema = z.strictObject({
  intent: z.enum(ROUTE_INTENTS),
  confidence: z.number().min(0).max(1),
  target: z
    .strictObject({
      view: z.enum(ROUTE_VIEWS).optional(),
      toolId: z.string().min(1).optional(),
      subject: z.string().min(1).max(80).optional(),
    })
    .optional(),
});
export type RouteReading = z.infer<typeof routeSchema>;

/** 低于这个置信度就当没听懂（宁可不猜）。 */
export const ROUTE_MIN_CONFIDENCE = 0.55;

/** 分类失败/低置信时用的兜底结果。 */
const UNKNOWN: RouteReading = { intent: 'unknown', confidence: 0 };

/**
 * 关键词表：模型不可用时的确定性回落。按「最长匹配」取一条，一个都不中就是 unknown。
 * 词表只认**用户会怎么说**，不猜业务；同一句话命中多条时取匹配片段最长的那条。
 */
const KEYWORDS: { intent: RouteIntent; words: string[]; view?: RouteView }[] = [
  {
    intent: 'navigate',
    words: ['带我去', '打开首页', '去岗位', '去简历', '去运行记录', '去工作流', '去模型', '去诊断', '看追踪'],
  },
  { intent: 'summary', words: ['投了几份', '投了几笔', '进度', '额度', '还剩', '统计', '最近一笔'] },
  { intent: 'draft_plan', words: ['准备一轮', '起草', '计划', '安排一轮'] },
  { intent: 'reminder', words: ['有什么事', '有什么要我', '待办', '提醒', '卡住', '暂停了', '要不要处理'] },
  { intent: 'explain', words: ['为什么匹配', '为什么', '理由', '解释', '匹配度'] },
  { intent: 'act', words: ['打招呼', '投递这份', '直接发', '帮我发', '执行'] },
];

/** 关键词 → 工作台（跳转类要用）。 */
const VIEW_WORDS: { word: string; view: RouteView }[] = [
  { word: '首页', view: 'chat' },
  { word: '岗位', view: 'jobs' },
  { word: '简历', view: 'resume' },
  { word: '工作流', view: 'workflow' },
  { word: '模型', view: 'models' },
  { word: '运行记录', view: 'trust' },
  { word: '诊断', view: 'diagnostics' },
  { word: '追踪', view: 'trust' },
  { word: '统计', view: 'trust' },
];

/**
 * 解释类要查的那几个词：把提问的框子去掉，只留主题（否则整句丢进检索一条都命不中）。
 * 词表只去疑问/招呼成分，不删用户真正在问的名词。
 */
const EXPLAIN_STOPWORDS = [
  '解释',
  '说明',
  '一下',
  '为什么',
  '为啥',
  '这个',
  '那个',
  '岗位',
  '匹配',
  '理由',
  '的',
  '是',
  '吗',
  '呢',
  '？',
  '?',
  '。',
  '，',
];

/**
 * 从一句「为什么匹配」里取检索词（纯函数，单测可断言）。
 * @param text 用户原话
 * @returns 去掉框子后的检索词；全被去掉时退回原句（宁可查原句，也别查空串）
 */
export function explainQuery(text: string): string {
  let rest = text;
  for (const word of EXPLAIN_STOPWORDS) rest = rest.split(word).join(' ');
  const trimmed = rest.replace(/\s+/g, ' ').trim();
  return trimmed === '' ? text.trim() : trimmed;
}

/**
 * 关键词回落：不调模型也能把六类里的大多数认出来。
 * @param text 用户原文（已去空）
 * @returns 分类结果；一条都不中时是 `unknown`（不猜）
 */
export function classifyByKeywords(text: string): RouteReading {
  let best: { intent: RouteIntent; length: number } | null = null;
  for (const row of KEYWORDS) {
    for (const word of row.words) {
      if (text.includes(word) && (best === null || word.length > best.length)) {
        best = { intent: row.intent, length: word.length };
      }
    }
  }
  if (best === null) return UNKNOWN;
  if (best.intent === 'navigate') {
    const hit = VIEW_WORDS.find((row) => text.includes(row.word));
    return { intent: 'navigate', confidence: 0.6, target: hit ? { view: hit.view } : undefined };
  }
  return { intent: best.intent, confidence: 0.6 };
}

/** 模型口：只要求「给一句话、回一段 JSON」这一件事，与 `llm.chat` 的既有形状一致。 */
export interface RouteModelPort {
  /**
   * @param systemPrompt 分类提示词（来自注册表）
   * @param userText 用户原话
   * @param timeoutMs 本次等待上限
   * @returns 模型原文（调用方负责从中抠 JSON）
   */
  complete: (systemPrompt: string, userText: string, timeoutMs: number) => Promise<string>;
}

/**
 * 走模型分类；任何失败（无通道、超时、非 JSON、schema 不符、置信度低）都回落关键词。
 * @param text 用户原文
 * @param model 模型口；undefined 表示没有通道
 * @param timeoutMs 分类等待上限
 * @returns 分类结果 + 来源（`model` / `keywords`）
 */
export async function routeIntent(
  text: string,
  model: RouteModelPort | undefined,
  timeoutMs = 3_500,
): Promise<{ reading: RouteReading; via: 'model' | 'keywords' }> {
  if (model) {
    try {
      const raw = await Promise.race([
        model.complete(ROUTE_PROMPT, text, timeoutMs),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('route timeout')), timeoutMs)),
      ]);
      const parsed = routeSchema.safeParse(JSON.parse(extractJson(raw)));
      if (parsed.success && parsed.data.confidence >= ROUTE_MIN_CONFIDENCE) {
        return { reading: parsed.data, via: 'model' };
      }
    } catch {
      // 落到关键词：没有 key、超时、模型乱回都不许让助手哑掉。
    }
  }
  const reading = classifyByKeywords(text);
  return { reading, via: 'keywords' };
}

/**
 * 从模型输出里抠出第一段 JSON（模型常包一层 ```json 或前后加一句话）。
 * @param raw 原始输出
 * @returns 可能的 JSON 文本（解析失败由调用方兜）
 */
function extractJson(raw: string): string {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  return start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
}
