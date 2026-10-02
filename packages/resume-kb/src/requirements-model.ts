/**
 * JD 文本 → 能力要求列表的**模型腿**（spec 4.4-02 的模型分支与可见回落）。
 *
 * 与词面腿（`requirements.ts`）的分工是「基线 + 增强」，不是「两条并列的实现」：
 * 词面腿每次都跑、永远先出结果，模型腿只在它上面**补**词面抓不到的长尾表达。
 * 这样模型不可用时报告只是短一些，流程一个都不会断（4.4-02 的「功能不中断」）。
 *
 * 三条判据立在纯函数这一层，服务层（`gap-service.ts`）只做装配与播报：
 * 1. **只认能对回原文的条目**（AGENTS.md §8.4 事实锁定在 4.4 上的对应物）：模型必须逐字给出 JD 里的
 *    引文，位置由本文件用 `indexOf` 自己算——模型报的下标一概不收（它对 UTF-16 下标没有可靠概念）。
 *    引文在原文里找不到就丢弃并计入 `droppedUnlocatable`，绝不为了让报告好看而保留一条无据的要求；
 * 2. **确定性**：模型返回的次序先按「四类表次序 → 起始下标」归一，再与词面腿合并，
 *    所以同一个词面结果 + 同一份模型输出永远得到同一个合并序列（4.4-07 的稳定性判据接得上）；
 * 3. **纯函数**：这里不发请求、不碰 cordis、不开连接（4.4-08），提示词只是拼字符串。
 *
 * 提示词与判据全部是本仓库自写的中文表达，未从任何参考项目搬运（plan §4.4-b 证据 [1]：
 * `.research-repos/src/ai-resume-master/server/src/prompts/jdParse.ts` 只借了「四类划分」这个口径，
 * 它的提示词本文我们没有复制，也没有沿用它的 `responseFormat:'json'` 免校验读法）。
 */
import { z } from 'zod';
import {
  REQUIREMENT_KINDS,
  dedupeAndSort,
  isFreeSpan,
  type RequirementItem,
  type RequirementKind,
} from './requirements.js';

/**
 * 提示词版本（同 2.5-09 的 `scriptVersion` 与 4.4-a 的 `lexiconVersion` 口径）：
 * 改提示词必须同时改它，否则 4.4-07 复盘时分不清某份报告是哪一版产的。
 */
export const REQUIREMENT_PROMPT_VERSION = 'jdreq-v1';

/**
 * 模型契约里的一条声明（还没定位，`quote` 是模型声称的原文片段）。
 *
 * `label` 上限 40 字符 / `quote` 上限 200：超出即判为模型在复述整段 JD 而不是引一条要求，
 * 那种条目定位到的区间会覆盖别的答案，宁可丢掉（校验只在系统边界做，§2.6）。
 */
const claimSchema = z.strictObject({
  kind: z.enum(REQUIREMENT_KINDS),
  label: z.string().min(1).max(40),
  quote: z.string().min(1).max(200),
});

/** 模型契约的一条的推断类型。 */
type ModelClaim = z.infer<typeof claimSchema>;

/**
 * 归一化 label 用于「模型说的和词面腿说的是同一条要求」的判定。
 * @param label 任一条腿给出的代表词
 * @returns 去首尾空白、去内部空白、转小写后的形态（大小写与空格差异不算两条要求）
 */
function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, '');
}

/**
 * 从定位到的引文里取经验年限的数字。
 *
 * 年限只从**原文**推，不采信模型自己填的数（模型经常把「3 年」写成「三年以上」再算成 4）。
 * @param quote JD 原文里实际出现的那一段
 * @returns 引文里第一个「N 年」的 N；引文里没有数字时 null（界面按「年限未知」显示，不当 0 年）
 */
function yearsFromQuote(quote: string): number | null {
  const matched = /(\d{1,2})\s*年/.exec(quote);
  const value = matched ? Number(matched[1]) : Number.NaN;
  return Number.isNaN(value) ? null : value;
}

/**
 * 拼给模型的两句消息（system 定规矩，user 给原文）。
 *
 * 里面没有端点、没有模型名、也没有 key（AGENTS.md §2.7 的入口唯一性由 `check-llm-single-entry` 机检），
 * 传输全在 `llm.chat`。
 * @param jdText 待拆解的 JD 正文（去空白后）
 * @param limitPerKind 每类最多几条，进提示词约束模型别把整段技术清单倒出来
 * @returns 可直接交给 `ChatGateway.complete` 的消息序列
 */
export function buildRequirementMessages(
  jdText: string,
  limitPerKind: number,
): Array<{ role: 'system' | 'user'; content: string }> {
  const system =
    '你在帮中国求职者拆解招聘 JD 里的能力要求。只依据我给出的 JD 原文，不得引入原文没有的要求，' +
    '不得编造公司、岗位、技术名词或年限。' +
    `每一项给出：类别 kind（只能是 hard_skill / soft_skill / education / experience_years）、` +
    `代表词 label（用业界通用写法，同一能力只算一项）、原文引文 quote（必须逐字摘自 JD 原文，不超过 40 字）。` +
    `每类最多 ${String(limitPerKind)} 项。只输出 JSON，形如 {"items":[{"kind":"hard_skill","label":"React","quote":"精通 React"}]}，` +
    '不要输出解释、注释或代码块以外的任何文字。';
  return [
    { role: 'system', content: system },
    { role: 'user', content: `请拆解以下 JD 原文中的能力要求：\n${jdText}` },
  ];
}

/**
 * 剥掉模型常用的 Markdown 代码围栏与前后空白。
 *
 * 单列成函数并**对外可见**是因为「模型把 JSON 包在 ```json 里」是实测常见形态（`outbound.script` 那边是纯文本所以没这问题），
 * 判据只该有一处：本文件与 4.5 的生成腿（`generate-model.ts`）读的都是同一份模型回复，
 * 第二份围栏剥离实现就是第二套判据（AGENTS.md §2.2/§2.5）。
 * @param text 模型回复正文
 * @returns 去掉围栏与首尾空白后的文本
 */
export function stripFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const body = trimmed.slice(trimmed.indexOf('\n') + 1);
  const fenceEnd = body.lastIndexOf('```');
  return (fenceEnd >= 0 ? body.slice(0, fenceEnd) : body).trim();
}

/**
 * 把引文定位回 JD 原文。
 * @param jdText JD 原文（与提示词里给模型的那一份同一个字符串）
 * @param quote 模型声称的原文片段
 * @returns 起始下标（UTF-16 code unit，不含式区间由调用方按 `quote.length` 补）；找不到时 -1
 */
function locateQuote(jdText: string, quote: string): number {
  const exact = jdText.indexOf(quote);
  if (exact >= 0) return exact;
  // 模型常把引文两侧的空格也带上，多一次去空白尝试；再找不到就是真的不在原文里。
  return jdText.indexOf(quote.trim());
}

/** 一次模型输出的读取结果。 */
export interface ModelRequirementsRead {
  /** 通过契约校验**且**在原文里定位到的条目，未与词面腿合并（`via` 已标成 model） */
  accepted: RequirementItem[];
  /** 整份输出不可用时的原因（供界面播报）；可用时为 null */
  reason: string | null;
  /** 因引文在原文里找不到、或与已收录条目认领同一处原文而被丢弃的条数（事实锁定的代价必须可见） */
  droppedUnlocatable: number;
  /** 因不符合契约（类别不在四类、字段缺失、文本超长）而被丢弃的条数 */
  droppedInvalid: number;
}

/**
 * 读一份模型输出：解析 JSON、逐条校验契约、逐条定位引文。
 * @param rawText 模型回复正文（可能带代码围栏）
 * @param jdText 提示词里给模型的那份 JD 原文
 * @returns 可用条目 + 两类丢弃计数；JSON 不合法或结构不对时 `reason` 非 null 且 `accepted` 为空
 */
export function readModelRequirements(rawText: string, jdText: string): ModelRequirementsRead {
  const empty = { accepted: [] as RequirementItem[], droppedUnlocatable: 0, droppedInvalid: 0 };
  const text = stripFence(rawText);
  if (text.length === 0) return { ...empty, reason: '模型返回空内容' };
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ...empty, reason: '模型产出不是合法 JSON' };
  }
  const claims = (payload as { items?: unknown }).items;
  if (!Array.isArray(claims)) return { ...empty, reason: '模型产出缺少 items 数组' };

  const accepted: RequirementItem[] = [];
  let droppedUnlocatable = 0;
  let droppedInvalid = 0;
  for (const claim of claims) {
    const parsed = claimSchema.safeParse(claim);
    if (!parsed.success) {
      droppedInvalid += 1;
      continue;
    }
    const located = appendLocated(accepted, parsed.data, jdText);
    if (!located) droppedUnlocatable += 1;
  }
  if (accepted.length === 0) {
    const reason =
      droppedUnlocatable + droppedInvalid === 0
        ? '模型未拆出能力要求'
        : `模型产出的 ${String(droppedUnlocatable + droppedInvalid)} 条均无法采信（引文对不上原文或不合契约）`;
    return { accepted, droppedUnlocatable, droppedInvalid, reason };
  }
  return { accepted, droppedUnlocatable, droppedInvalid, reason: null };
}

/**
 * 把一条契约声明定位成一条要求并追加进结果（就地改 `accepted`）。
 * @param accepted 已收录的条目（用于避免同一处原文被模型重复认领）
 * @param claim 通过契约校验的一条声明
 * @param jdText JD 原文
 * @returns 收录成功为 true；引文找不到、或与已收录条目区间重叠时为 false
 */
function appendLocated(accepted: RequirementItem[], claim: ModelClaim, jdText: string): boolean {
  const start = locateQuote(jdText, claim.quote);
  if (start < 0) return false;
  const end = start + claim.quote.length;
  if (!isFreeSpan(accepted, start, end)) return false;
  accepted.push({
    kind: claim.kind,
    label: claim.label,
    quote: jdText.slice(start, end),
    start,
    end,
    years: claim.kind === 'experience_years' ? yearsFromQuote(claim.quote) : null,
    via: 'model',
  });
  return true;
}

/** 模型腿与词面腿合并后的读数。 */
export interface ModelMergeResult {
  /** 合并并按「四类次序 → 起始下标」排好的稳定序列 */
  items: RequirementItem[];
  /** 模型腿实际并入的条数 */
  added: number;
  /** 与词面腿指同一条要求（同类别同代表词，或原文区间重叠）而未并入的条数 */
  droppedDuplicate: number;
  /** 因该类别已达每类上限而未并入的条数 */
  droppedByLimit: number;
}

/**
 * 把模型腿的条目并进词面腿的基线。
 *
 * 词面腿永远是底座：它已经跑过、已经带位置，模型只在它没覆盖到的地方补。
 * 两条腿指同一处原文时保留词面那条——它的 label 来自受控词表，比模型的自由写法更可比（4.4-c 要做比对）。
 * @param lexical 词面腿的产出（已按每类上限截断）
 * @param model `readModelRequirements` 收录的条目
 * @param limitPerKind 每类上限（与词面腿同一个配置值）
 * @returns 合并序列 + 三个计数（并入 / 判重丢弃 / 触顶丢弃）
 */
export function mergeModelWithLexical(
  lexical: readonly RequirementItem[],
  model: readonly RequirementItem[],
  limitPerKind: number,
): ModelMergeResult {
  const ordered = dedupeAndSort(model);
  const occupied = [...lexical];
  const knownKeys = new Set(lexical.map((item) => `${item.kind}:${normalizeLabel(item.label)}`));
  const usedByKind = new Map<RequirementKind, number>();
  for (const item of lexical) usedByKind.set(item.kind, (usedByKind.get(item.kind) ?? 0) + 1);

  const added: RequirementItem[] = [];
  let droppedDuplicate = 0;
  let droppedByLimit = 0;
  for (const item of ordered) {
    const key = `${item.kind}:${normalizeLabel(item.label)}`;
    if (knownKeys.has(key) || !isFreeSpan(occupied, item.start, item.end)) {
      droppedDuplicate += 1;
      continue;
    }
    const used = usedByKind.get(item.kind) ?? 0;
    if (used >= limitPerKind) {
      droppedByLimit += 1;
      continue;
    }
    usedByKind.set(item.kind, used + 1);
    knownKeys.add(key);
    occupied.push(item);
    added.push(item);
  }
  return {
    items: dedupeAndSort([...lexical, ...added]),
    added: added.length,
    droppedDuplicate,
    droppedByLimit,
  };
}
