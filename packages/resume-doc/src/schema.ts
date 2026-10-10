/**
 * 文档 Schema 与校验（spec 3.1-02 / 3.1-03）。
 *
 * 两条入口分开，语义不同：
 * ① `validateDocument` 是**权威校验**，用 `strictObject` 拒未知键——它给「这份 JSON 是不是合法模型」
 *    一个确定答案，且非法时返回**可读**错误（路径 + 期望 + 实际），绝不抛裸异常（3.1-02）；
 * ② `importExternal`（见 import.ts）是**容错导入**，走另一套：丢弃未知字段并告警，而不是直接判非法。
 * 用 strict 做导入会把「旧格式多了个字段」误杀成非法，所以两者必须是两个函数而不是一个 flag。
 *
 * `checkFactLock` 是跨两份文档的判定，Schema 表达不了，单列在此（3.1-03）。
 */
import { z as zod } from 'zod';
import {
  FONT_FAMILY_TOKENS,
  FONT_WEIGHT_TOKENS,
  TEXT_ALIGN_TOKENS,
  factKeyOf,
  type Entry,
  type FactKey,
  type ResumeDocument,
  type Section,
} from './model.js';

const factKeySchema = zod.enum(['company', 'role', 'period', 'achievement']);

/** 区块种类（样式层按它寻址段落，所以与 `sectionSchema` 共用一份枚举，§2.5 一个判据一个出处）。 */
const sectionKindSchema = zod.enum(['summary', 'experience', 'education', 'skills', 'project', 'campus']);

/** 字重档枚举：清单在 `model.ts`（编辑器的输入闸门与界面都用它，不各抄一份）。 */
const fontWeightSchema = zod.enum(FONT_WEIGHT_TOKENS);

/** 对齐档枚举（与 CSS `text-align` 同口径）。 */
const textAlignSchema = zod.enum(TEXT_ALIGN_TOKENS);

/**
 * 一条十六进制颜色（`#rrggbb`）。
 * 只认这一种形状是刻意的：样式层的值要一路写进**产物文档**的 `<style>` 块里，
 * 放开成自由字符串就等于把注入面交给用户输入（§8 的系统边界口径）。
 * 模式单列在这里，编辑器的闸门（`editor-ops.ts` 的 `planDesign`）引用同一只——
 * 判"能不能进文档"与判"能不能进 draft"必须是同一件事，否则会出现"界面放行、保存被拒"的分叉。
 */
export const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

const hexColorSchema = zod.string().regex(HEX_COLOR_PATTERN, '需要 #rrggbb 形式的十六进制颜色');

const fieldSchema = zod.strictObject({
  key: zod.string().min(1),
  value: zod.string(),
  locked: zod.boolean(),
  factKey: zod.nullable(factKeySchema),
});

const entrySchema = zod.strictObject({
  id: zod.string().min(1),
  fields: zod.array(fieldSchema),
});

const sectionSchema = zod.strictObject({
  id: zod.string().min(1),
  kind: sectionKindSchema,
  title: zod.string(),
  entries: zod.array(entrySchema),
});

/** 一段落（按区块种类）的样式覆盖：每条轴都可缺省。 */
const paragraphStyleSchema = zod.strictObject({
  sizePt: zod.number().positive().optional(),
  weight: fontWeightSchema.optional(),
  align: textAlignSchema.optional(),
  lineHeight: zod.number().positive().optional(),
  inkHex: hexColorSchema.optional(),
  backdropHex: hexColorSchema.optional(),
});

/** 文档主题（spec 6.6-01）：整块可缺省，缺省 = 完全随模板。 */
const designSchema = zod.strictObject({
  inkHex: hexColorSchema.optional(),
  paperHex: hexColorSchema.optional(),
  accentHex: hexColorSchema.optional(),
  body: zod
    .strictObject({
      fontFamily: zod.enum(FONT_FAMILY_TOKENS).optional(),
      sizePt: zod.number().positive().optional(),
      weight: fontWeightSchema.optional(),
    })
    .optional(),
  paragraphs: zod.partialRecord(sectionKindSchema, paragraphStyleSchema).optional(),
});

const layoutSchema = zod.strictObject({
  pageSize: zod.literal('A4'),
  margin: zod.strictObject({
    topMm: zod.number(),
    rightMm: zod.number(),
    bottomMm: zod.number(),
    leftMm: zod.number(),
  }),
  baseFontPt: zod.number().positive(),
  lineHeight: zod.number().positive(),
  columns: zod.number().int().min(1).max(2),
  design: designSchema.optional(),
});

const profileSchema = zod.strictObject({
  name: zod.string(),
  contact: zod.strictObject({
    email: zod.nullable(zod.string()),
    phone: zod.nullable(zod.string()),
    location: zod.nullable(zod.string()),
  }),
});

const metricsSchema = zod.strictObject({ pages: zod.number().int().min(1) });

/** 文档权威 Schema（strict：未知键即非法）。 */
export const documentSchema = zod.strictObject({
  id: zod.string().min(1),
  schemaVersion: zod.number().int().positive(),
  profile: profileSchema,
  layout: layoutSchema,
  sections: zod.array(sectionSchema),
  metrics: metricsSchema,
  updatedAt: zod.number().int().nonnegative(),
});

/** 单条可读校验错误：路径（点号 + 下标串）、期望、实际、一句话说明。 */
export interface ReadableIssue {
  path: string;
  expected: string;
  actual: string;
  message: string;
}

/** 校验结果：成功带规范化的文档，失败带可读错误列表（永不 throw，3.1-02）。 */
export type ValidateResult = { ok: true; document: ResumeDocument } | { ok: false; issues: ReadableIssue[] };

/**
 * 把 zod 的 issue path 压成人能读的字符串。
 * @param path issue 的路径段数组（对象键为 string、数组下标为 number）
 * @returns 形如 `sections[0].fields.company` 的定位串；根对象返回 `(root)`
 */
function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '(root)';
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${String(seg)}]`;
    else out += out === '' ? String(seg) : `.${String(seg)}`;
  }
  return out;
}

/**
 * 把 zod issue 上的任意值渲染成人读文本——对象走 JSON 而不是默认的 `[object Object]`，
 * 否则「期望/实际」两栏在最需要看得懂的场景（结构对不上）反而最看不懂。
 * @param value issue 的 expected / received 原始值
 * @returns 可读文本；字符串原样，其余（含对象/数组/null/数字）交给 JSON.stringify
 */
function toReadableText(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  // null → "null"、数字 → "42"、对象/数组 → JSON：一律交给 JSON.stringify，比 String() 的 [object Object] 可读。
  return JSON.stringify(value);
}

/**
 * 把 zod 期望值（可能是枚举数组 / 字面量）渲染成简短文本。
 * @param raw zod issue 上的 expected 原始值
 * @returns 可读文本；无则返回「合法值」
 */
function renderExpected(raw: unknown): string {
  if (raw === undefined) return '合法值';
  if (Array.isArray(raw)) return raw.map((item) => toReadableText(item)).join(' | ');
  return toReadableText(raw);
}

/**
 * 校验任意 JSON 值是否为合法简历文档。
 * @param raw 待校验的未知输入（可能来自文件、网络、旧格式）
 * @returns ok:true 带通过校验的文档；ok:false 带**逐条可读**错误（路径 + 期望 + 实际）
 */
export function validateDocument(raw: unknown): ValidateResult {
  const parsed = documentSchema.safeParse(raw);
  if (parsed.success) {
    return { ok: true, document: parsed.data };
  }
  const issues: ReadableIssue[] = parsed.error.issues.map((issue) => {
    const record = issue as unknown as Record<string, unknown>;
    const received = record['received'];
    return {
      path: formatPath(issue.path),
      expected: renderExpected(record['expected']),
      actual: received === undefined ? issue.message : toReadableText(received),
      message: issue.message,
    };
  });
  return { ok: false, issues };
}

/** 一条锁定违规是被哪一道判据拦下的（同一字段可能两道都成立，取更强的一道）。 */
export const FACT_VIOLATION_GATES = ['fact-lock', 'editable-allowlist'] as const;

/** 违规来源：模型级事实锁（3.1-03），或生成轨的「可改写键白名单」之外（4.5-03）。 */
export type FactViolationGate = (typeof FACT_VIOLATION_GATES)[number];

/** 一条事实锁定违规：某个不许改动的字段在生成轨里被改动了值。 */
export interface FactViolation {
  sectionId: string;
  entryId: string;
  fieldKey: string;
  /** 事实类别；只有模型里标了锁的字段有值。`school / degree / major` 这类"生成轨不许动、模型未标锁"的为 null。 */
  factKey: FactKey | null;
  /** 是哪一道判据拦下的（界面与复盘要分清"改了一条事实"与"改了不该改的字段"）。 */
  gate: FactViolationGate;
  before: string;
  after: string;
}

/** 取条目里指定键的字段值；不存在返回 undefined。 */
function fieldValue(entry: Entry, key: string): string | undefined {
  return entry.fields.find((field) => field.key === key)?.value;
}

/**
 * 比较生成前 / 生成后两份文档，找出不许改动的字段被改动的地方（3.1-03 + 4.5-03）。
 *
 * 判据（缺省，即 3.1-03 的原语义，不传第三个参数时逐字不变）：同一区块、同一 id 条目、同一 key 的字段，
 * 若在原文件里 `locked` 且值与结果不同即违规。新增条目 / 新增字段不算违规；只有**篡改既有事实**才拦。
 *
 * 判据（传 `editableKeys`，即生成轨口径）：语义反过来——**白名单里的键允许改写，其余字段一律原样引用**。
 * 反过来的理由是 `school / degree / major` 在模型里不标锁（3.1 的 `FactKey` 只有四类事实），
 * 但"把学校改成另一所"仍是编造。加枚举会牵动 schema / 快照 hash / 模板 / diff，而这里是校验面的一条口径，
 * 所以用一个参数表达，比对实现仍只有一份（AGENTS.md §2.5）。
 * @param original 生成轨输入的基线（来自知识库确认过的事实）
 * @param proposed 生成轨产出的候选
 * @param editableKeys 允许改写的字段键；省略时沿用 3.1-03 的「只比 locked 字段」判据
 * @returns 违规列表；空数组表示生成轨没动任何不许动的字段
 */
export function checkFactLock(
  original: ResumeDocument,
  proposed: ResumeDocument,
  editableKeys?: readonly string[],
): FactViolation[] {
  const violations: FactViolation[] = [];
  const allowlist = editableKeys === undefined ? null : new Set(editableKeys);
  const originalSections = new Map<string, Section>(original.sections.map((section) => [section.id, section]));
  for (const section of proposed.sections) {
    const base = originalSections.get(section.id);
    if (!base) continue;
    const baseEntries = new Map<string, Entry>(base.entries.map((entry) => [entry.id, entry]));
    for (const entry of section.entries) {
      const baseEntry = baseEntries.get(entry.id);
      if (!baseEntry) continue;
      for (const field of entry.fields) {
        // 缺省口径只比 locked 字段；白名单口径比"不在白名单里的全部字段"（locked 的自然落在里面）。
        const compared = allowlist === null ? field.locked : !allowlist.has(field.key);
        if (!compared) continue;
        const before = fieldValue(baseEntry, field.key);
        if (before !== undefined && before !== field.value) {
          violations.push({
            sectionId: section.id,
            entryId: entry.id,
            fieldKey: field.key,
            factKey: field.factKey,
            gate: field.locked ? 'fact-lock' : 'editable-allowlist',
            before,
            after: field.value,
          });
        }
      }
    }
  }
  return violations;
}

/** 供 model.test 复用的锁定键判定，避免测试反向依赖 zod。 */
export { factKeyOf };
