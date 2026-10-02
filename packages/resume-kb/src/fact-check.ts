/**
 * 定向生成结果的事实校验（spec 4.5-03 / 04 / 08 的确定性半边，plan §4.5 取证一/三与判据六）。
 *
 * 三条判据各管一段，全部是**确定性代码**，不问模型"这段你觉得可信吗"（plan §6「不做 prompt 注入式自证」）：
 *
 * 1. **字段原样引用**：复用 `resume-doc` 的 `checkFactLock`，传入生成轨的可改写白名单——
 *    比对实现只有一份（AGENTS.md §2.5），本文件不重写任何字段级 diff。
 * 2. **数值守恒**：可改写散文里的数值**多重集**必须与基线相等。少一个数是「把提升 20% 写成大幅提升」，
 *    多一个数是凭空放大——两个方向都要拦（4.5-08）。
 * 3. **具名候选回查**：散文里出现的组织名形态候选，必须能在基线词表或 JD 原文里找到（4.5-07 的补刀，
 *    强保证在结构面：模型腿没有新增条目的通道，见 plan §4.5 判据六）。
 *
 * 本文件不认识 cordis，也不打开任何 SQLite 连接：校验规则要能离线、逐条断言
 * （与 `sections.ts` / `evidence.ts` / `requirements-compare.ts` 同一规矩，装配与入库留在服务层）。
 */
import { redactText } from '@auto-cc/core';
import { checkFactLock, type FactViolation, type ResumeDocument, type SectionKind } from '@auto-cc/plugin-resume-doc';

/**
 * 生成轨允许改写的字段键。
 *
 * 当前文档模型的字段词表是 `company / role / period / achievement / school / degree / major / text`
 * （见 `sections.ts` 与 `resume-doc/src/export-service.ts`），其中只有 `text` 装散文
 * （summary 正文、技能行、区块正文），其余都是结构化事实。`achievement` 在模型里已经标了锁，
 * 所以"整句原样引用"由第 1 条判据保证，4.5-08 要检的是 `text` 里的数值。
 */
export const GENERATION_EDITABLE_KEYS = ['text'] as const;

/** 参与「组织名候选」抽取的区块种类（联系资料与技能行不算具名实体来源）。 */
const ENTITY_BEARING_SECTION_KINDS: readonly SectionKind[] = [
  'summary',
  'experience',
  'project',
  'campus',
  'education',
];

/** 基线里能当作「已知具名实体」的字段键——公司名与学校名。 */
const KNOWN_NAME_KEYS = ['company', 'school'] as const;

/**
 * 中文数词到数值的映射（单字）。
 * 「〇/零」在这里只作占位（`108` 式读法本项目不出现），出现即按 0 参与组合。
 * @internal
 */
const CN_DIGIT_VALUE: Readonly<Record<string, number>> = {
  〇: 0,
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 节内单位（十 / 百 / 千）。@internal */
const CN_INNER_UNIT: Readonly<Record<string, number>> = { 十: 10, 百: 100, 千: 1000 };

/** 节单位（万 / 亿）。@internal */
const CN_SECTION_UNIT: Readonly<Record<string, number>> = { 万: 10000, 亿: 100000000 };

/** 中文数词字符集（含节单位），用于正则的字符类。@internal */
const CN_NUMERAL_CHARS = '〇零一二两三四五六七八九十百千万亿';

/**
 * 跟在中文数词后面才让它算"一个数值"的量词集。
 *
 * 这条限定不是可有可无：中文里「十分符合」「万分感谢」的「十 / 万」是副词强度，不是数据。
 * 不加限定，模型把「十分匹配」润色成「非常匹配」就会被判成"弄丢了一个 10"。
 * 「成」刻意不在表内（「两成」= 20%，与 2 无法在同一口径下比较，宁可两边都不数）。
 * @internal
 */
const CN_COUNTING_UNITS = '个年月日天周岁人次倍家项条元名级位种';

/**
 * 数值抽取用的单一正则：阿拉伯数字（可带千分位、小数、紧随的千百十万亿量级）或
 * 「中文数词 + 量词」。两个分支按位置从左到右互斥，避免「3万人」被数两遍。
 * @internal
 */
const NUMBER_RUN = new RegExp(
  [String.raw`\d[\d,]*(?:\.\d+)?[ ]?[千百十万亿]?`, `[${CN_NUMERAL_CHARS}]+[ ]?[${CN_COUNTING_UNITS}]`].join('|'),
  'g',
);

/**
 * 组织名候选的正则：若干汉字/字母数字后跟一个机构后缀。
 *
 * 前缀刻意写成"贪婪到 24 字"，因为「主导了星桥科技的订单重构」里紧挨后缀的读数是「主导了星桥科技」——
 * 这条候选靠"包含已知名即放行"来消解，不靠收窄正则（收窄会把真名也切掉）。
 * @internal
 */
const ORG_CANDIDATE_RUN =
  /[\u4e00-\u9fffA-Za-z0-9（）()·]{2,24}(?:公司|集团|大学|学院|研究院|研究所|实验室|银行|证券|事务所|医院|事业部|社区)/g;

/**
 * 指代词前缀——「本公司 / 该校 / 这家集团」这类候选不是具名实体，不参与回查。
 * @internal
 */
const DEMONSTRATIVE_PREFIXES = ['本', '该', '这', '那', '前', '现', '原', '贵', '我', '各', '同'] as const;

/** 一条数值守恒读数：某个位置的散文少了 / 多了哪些数。 */
export interface NumberFinding {
  readonly sectionId: string;
  readonly entryId: string;
  readonly fieldKey: string;
  /** 基线有、生成结果没有的数（「20%」被写成「大幅」）。 */
  readonly missing: readonly string[];
  /** 生成结果新出现的数（凭空「提升 50%」）。 */
  readonly added: readonly string[];
}

/** 一条具名候选回查读数。 */
export interface EntityFinding {
  readonly sectionId: string;
  readonly entryId: string;
  readonly fieldKey: string;
  /** 被拦下的候选原文（进读数前已过 `redactText`，4.5-14）。 */
  readonly candidate: string;
}

/** 一次事实校验的完整读数。 */
export interface GenerationCheckReport {
  /** 三条判据全部为空才为 true（4.5-05 的"拒绝产出"就看这一位）。 */
  readonly ok: boolean;
  /** 字段级篡改（带 before/after，界面与重试提示要用）。 */
  readonly fieldViolations: readonly FactViolation[];
  readonly numberFindings: readonly NumberFinding[];
  readonly entityFindings: readonly EntityFinding[];
}

/** 一次校验的输入。 */
export interface GenerationCheckInput {
  /** 基线文档（来自工作副本，事实已经过知识库确认）。 */
  readonly original: ResumeDocument;
  /** 生成候选。 */
  readonly proposed: ResumeDocument;
  /** JD 原文——JD 里出现的公司名不算虚构（投的就是这家）。 */
  readonly jdText: string;
  /** 可改写键白名单；省略时用 `GENERATION_EDITABLE_KEYS`。 */
  readonly editableKeys?: readonly string[];
}

/**
 * 把中文数词串解析成数值。
 * @param run 只含 `CN_NUMERAL_CHARS` 的串，如「二十三」「两万」「百万」
 * @returns 解析出的数值；串里有认不出的字或读不成一个数时返回 null（调用方按"不是数值"处理）
 */
export function chineseNumeralToNumber(run: string): number | null {
  let total = 0;
  let section = 0;
  let pending = 0;
  for (const char of run) {
    const digit = CN_DIGIT_VALUE[char];
    if (digit !== undefined) {
      pending = digit;
      continue;
    }
    const inner = CN_INNER_UNIT[char];
    if (inner !== undefined) {
      // 「十」单独开头时读作 10（十个人），不是 0×10。
      section += (pending === 0 ? 1 : pending) * inner;
      pending = 0;
      continue;
    }
    const sectionUnit = CN_SECTION_UNIT[char];
    if (sectionUnit !== undefined) {
      const current = section + pending;
      total += (current === 0 ? 1 : current) * sectionUnit;
      section = 0;
      pending = 0;
      continue;
    }
    return null;
  }
  return total + section + pending;
}

/**
 * 把一段数值读数渲染成稳定的文本键，供多重集比对与界面播报（整数不带小数点，避免 20 与 20.0 分成两类）。
 * @param value 解析出的数值
 * @returns 文本键，如「20」「1.5」
 */
export function numberKeyOf(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}

/**
 * 从一段文本里抽出全部数值（按出现顺序）。
 *
 * 归一化口径（plan §4.5 取证三）：量级折进数值（「2 万」=「20000」），百分号、货币与时间量词只作限定、
 * 不进比对；因此 4.5-08 判的是"这个数还在不在、有没有新数"，单位改写（3 个月 → 3 年）**不在本条射程内**，
 * 这一点在 spec 里如实标注，不写成"所有数字相关篡改都已拦"。
 * @param text 待抽取的文本
 * @returns 数值数组（含重复，按多重集使用）
 */
export function numbersOf(text: string): number[] {
  const values: number[] = [];
  for (const match of text.matchAll(NUMBER_RUN)) {
    const token = match[0];
    const arabic = /^\d/.test(token);
    if (arabic) {
      const digits = token.replace(/[,\s]/g, '');
      const magnitudeChar = /[千百十万亿]$/.test(digits) ? digits.slice(-1) : '';
      const body = magnitudeChar === '' ? digits : digits.slice(0, -1);
      const bodyValue = Number(body);
      if (!Number.isFinite(bodyValue)) continue;
      const magnitude =
        magnitudeChar === '' ? 1 : (CN_SECTION_UNIT[magnitudeChar] ?? CN_INNER_UNIT[magnitudeChar] ?? 1);
      values.push(bodyValue * magnitude);
      continue;
    }
    // 中文分支：末尾的量词只用来判"这串数词是不是在报数"，本身不进数值。
    const numeralRun = token.replace(/[ ]?[个年月日天周岁人次倍家项条元名级位种]$/, '');
    const value = chineseNumeralToNumber(numeralRun);
    if (value !== null) values.push(value);
  }
  return values;
}

/**
 * 比较两段散文的数值多重集。
 * @param originalText 基线散文
 * @param proposedText 生成结果散文
 * @returns 少掉与多出的数值键；两者都空表示数值守恒
 */
export function diffNumberMultiset(originalText: string, proposedText: string): { missing: string[]; added: string[] } {
  const counts = new Map<string, number>();
  for (const value of numbersOf(originalText))
    counts.set(numberKeyOf(value), (counts.get(numberKeyOf(value)) ?? 0) + 1);
  // 生成结果里的每个数都从计数里扣一份：扣成负数就是"多出来的数"，剩正数就是"丢掉的数"。
  // 用多重集而不是集合，否则「提升 20%，复用率 20%」改成一个 20% 也能过。
  for (const value of numbersOf(proposedText)) {
    const key = numberKeyOf(value);
    counts.set(key, (counts.get(key) ?? 0) - 1);
  }
  const missing: string[] = [];
  const added: string[] = [];
  for (const [key, count] of counts) {
    if (count > 0) missing.push(key);
    else if (count < 0) added.push(key);
  }
  return { missing, added };
}

/**
 * 归一化一条具名候选 / 已知名：去空白与标点、转小写。
 * @param value 原始文本
 * @returns 用于包含关系比较的紧凑串
 */
function normalizeEntityText(value: string): string {
  return value.toLowerCase().replace(/[\s（）()·、,，。．_.:：\-/／]/g, '');
}

/**
 * 收集基线文档里的已知具名实体（公司名、学校名）。
 * @param document 基线文档
 * @returns 归一化后的名称集合；空集合意味着库里没有任何可对照的具名实体
 */
export function collectKnownNames(document: ResumeDocument): Set<string> {
  const names = new Set<string>();
  for (const section of document.sections) {
    for (const entry of section.entries) {
      for (const field of entry.fields) {
        if (!(KNOWN_NAME_KEYS as readonly string[]).includes(field.key)) continue;
        const normalized = normalizeEntityText(field.value);
        if (normalized !== '') names.add(normalized);
      }
    }
  }
  return names;
}

/**
 * 判断一条具名候选是否为"指代词 + 后缀"这类非具名读法（本公司 / 该集团 / 在前公司）。
 *
 * 判"含指代字"而不是"以指代字开头"：正则的前缀是贪婪的，「在本公司」读到的前缀是「在本」，
 * 只比起首会把这条当成一个具名实体误报。
 * @param candidate 去掉机构后缀之后的前缀部分
 * @returns 属于指代词读法则为 true
 */
function isDemonstrativeReference(candidate: string): boolean {
  if (candidate.length > 3) return false;
  for (const char of candidate) {
    if ((DEMONSTRATIVE_PREFIXES as readonly string[]).includes(char)) return true;
  }
  return false;
}

/**
 * 在一段生成散文里回查具名候选。
 * @param proposedText 生成结果散文
 * @param knownNames 基线文档的已知具名实体集合（归一化）
 * @param jdText JD 原文（其中出现过的名字不算虚构）
 * @returns 找不到出处的候选列表（原文，由调用方决定是否脱敏）
 */
export function findUnknownEntityCandidates(
  proposedText: string,
  knownNames: ReadonlySet<string>,
  jdText: string,
): string[] {
  const normalizedJd = normalizeEntityText(jdText);
  const unknown: string[] = [];
  for (const match of proposedText.matchAll(ORG_CANDIDATE_RUN)) {
    const candidate = match[0];
    const normalized = normalizeEntityText(candidate);
    // 放行条件三条：包含一个已知名（"主导了星桥科技"）、被某个已知名包含、或本就在 JD 原文里。
    let known = false;
    for (const name of knownNames) {
      if (normalized.includes(name) || name.includes(normalized)) {
        known = true;
        break;
      }
    }
    if (known) continue;
    if (normalizedJd.includes(normalized) || normalized.includes(normalizedJd)) continue;
    const prefix = normalized.replace(
      /(公司|集团|大学|学院|研究院|研究所|实验室|银行|证券|事务所|医院|事业部|社区)$/,
      '',
    );
    if (isDemonstrativeReference(prefix)) continue;
    unknown.push(candidate);
  }
  return unknown;
}

/**
 * 取一个区块里所有"生成轨可改写"字段的 (条目, 字段) 组合，供数值与具名两条判据复用。
 * @param document 待遍历的文档（基线或候选各调一次，遍历口径必须一致，否则两条腿比的不是同一段文字）
 * @param editableKeys 可改写键白名单
 * @returns 位置与文本的三元组列表，顺序为区块 → 条目 → 字段
 */
function editableFieldsOf(
  document: ResumeDocument,
  editableKeys: readonly string[],
): Array<{ sectionId: string; entryId: string; fieldKey: string; text: string }> {
  const fields: Array<{ sectionId: string; entryId: string; fieldKey: string; text: string }> = [];
  for (const section of document.sections) {
    if (!ENTITY_BEARING_SECTION_KINDS.includes(section.kind)) continue;
    for (const entry of section.entries) {
      for (const field of entry.fields) {
        if (!editableKeys.includes(field.key)) continue;
        fields.push({ sectionId: section.id, entryId: entry.id, fieldKey: field.key, text: field.value });
      }
    }
  }
  return fields;
}

/**
 * 对一次定向生成结果做完整事实校验（4.5-03 / 04 / 07 / 08 的判据入口）。
 *
 * 校验是**纯函数**：不写库、不发消息、不调模型（4.5-04 的"不依赖 LLM 自评"靠的就是这个签名）。
 * @param input 基线文档、候选文档、JD 原文，以及可选的白名单覆盖
 * @returns 三条判据的合并读数；`ok` 为 false 时调用方必须拒绝产出（4.5-05）
 */
export function verifyGeneration(input: GenerationCheckInput): GenerationCheckReport {
  const editableKeys = input.editableKeys ?? GENERATION_EDITABLE_KEYS;
  const fieldViolations = checkFactLock(input.original, input.proposed, editableKeys);
  const baselineByKey = new Map(
    editableFieldsOf(input.original, editableKeys).map((field) => [
      `${field.sectionId}#${field.entryId}#${field.fieldKey}`,
      field.text,
    ]),
  );
  const numberFindings: NumberFinding[] = [];
  const entityFindings: EntityFinding[] = [];
  const knownNames = collectKnownNames(input.original);
  for (const field of editableFieldsOf(input.proposed, editableKeys)) {
    const location = `${field.sectionId}#${field.entryId}#${field.fieldKey}`;
    const originalText = baselineByKey.get(location);
    // 基线里根本没有这一段（候选新增了条目/字段）：由结构面把关（模型腿没有新增通道），这里不重复判。
    if (originalText === undefined) continue;
    if (originalText === field.text) continue;
    const { missing, added } = diffNumberMultiset(originalText, field.text);
    if (missing.length > 0 || added.length > 0) {
      numberFindings.push({
        sectionId: field.sectionId,
        entryId: field.entryId,
        fieldKey: field.fieldKey,
        missing,
        added,
      });
    }
    for (const candidate of findUnknownEntityCandidates(field.text, knownNames, input.jdText)) {
      entityFindings.push({ sectionId: field.sectionId, entryId: field.entryId, fieldKey: field.fieldKey, candidate });
    }
  }
  return {
    ok: fieldViolations.length === 0 && numberFindings.length === 0 && entityFindings.length === 0,
    fieldViolations,
    numberFindings,
    entityFindings,
  };
}

/**
 * 生成一份**可安全落日志 / 可进生成记录表**的违规读数（4.5-14 与 plan §4.5 判据三）。
 *
 * 只给路径、判据名、长度与数值键，不给字段原文：被拒的内容整段留在库里会诱导"绕过闸门自己捞出来用"，
 * 而复盘真正需要的是"哪一条、动了什么、原来多长"。
 *
 * 每条读数**整行再过一遍 `redactText`**（复用 core 的唯一脱敏口，§2.1）——这不是多余的保险：
 * 数值守恒的读数装的正是"少了哪个数"，而手机号本身就是一串数，不脱敏就等于把哨兵原样写进日志与库。
 * @param report 一次校验的读数
 * @returns 每条形如 `experience/e1.company → fact-lock（4 → 6 字符）` 的字符串
 */
export function describeViolations(report: GenerationCheckReport): string[] {
  const lines: string[] = [];
  for (const violation of report.fieldViolations) {
    lines.push(
      `${violation.sectionId}/${violation.entryId}.${violation.fieldKey} → ${violation.gate}（${String(
        violation.before.length,
      )} → ${String(violation.after.length)} 字符）`,
    );
  }
  for (const finding of report.numberFindings) {
    const parts: string[] = [];
    if (finding.missing.length > 0) parts.push(`少了 ${finding.missing.join('、')}`);
    if (finding.added.length > 0) parts.push(`多了 ${finding.added.join('、')}`);
    lines.push(
      `${finding.sectionId}/${finding.entryId}.${finding.fieldKey} → number-preservation（${parts.join('，')}）`,
    );
  }
  for (const finding of report.entityFindings) {
    lines.push(
      `${finding.sectionId}/${finding.entryId}.${finding.fieldKey} → unknown-entity（候选「${finding.candidate}」）`,
    );
  }
  return lines.map((line) => redactText(line));
}
