/**
 * 定向生成结果的事实校验（spec 4.5-03 / 04 / 08 的确定性半边，plan §4.5 取证一/三与判据六）。
 *
 * 三条判据各管一段，全部是**确定性代码**，不问模型"这段你觉得可信吗"（plan §6「不做 prompt 注入式自证」）：
 *
 * 1. **字段原样引用**：复用 `resume-doc` 的 `checkFactLock`，传入生成轨的可改写白名单——
 *    比对实现只有一份（AGENTS.md §2.5），本文件不重写任何字段级 diff。
 * 2. **数值守恒**：可改写散文里的数值**多重集**必须与基线相等。少一个数是「把提升 20% 写成大幅提升」，
 *    多一个数是凭空放大——两个方向都要拦（4.5-08）。抽取与比对实现在 `@auto-cc/core` 的 `numbers.ts`：
 *    话术侧的无据断言拦截（4.6-02）要的是同一份口径，而两个包同级，谁都不该 import 谁（AGENTS.md §4.1）。
 * 3. **具名候选回查**：散文里出现的组织名形态候选，必须能在基线词表或 JD 原文里找到（4.5-07 的补刀，
 *    强保证在结构面：模型腿没有新增条目的通道，见 plan §4.5 判据六）。
 *
 * 本文件不认识 cordis，也不打开任何 SQLite 连接：校验规则要能离线、逐条断言
 * （与 `sections.ts` / `evidence.ts` / `requirements-compare.ts` 同一规矩，装配与入库留在服务层）。
 */
import { diffNumberMultiset, redactText } from '@auto-cc/core';
import { checkFactLock, type FactViolation, type ResumeDocument, type SectionKind } from '@auto-cc/plugin-resume-doc';

/**
 * 生成轨允许改写的字段键（**散文键集合**，不是"非事实键"集合）。
 *
 * 4.5-03 的原文是「`facts.locked` 字段（公司 / 职位 / 时间 / 数字 / 学历 / 证书号）只能原样引用」——
 * 那份清单里没有「成果」。这不是疏漏：`achievement` 装的就是"主导订单服务重构，P99 延迟下降 40%"
 * 这类**描述性散文**，而简历里真正会被 JD 改写的正文只有它（`sections.ts:282` 把经历 / 项目 / 校园的
 * 正文键定为 `achievement`，教育正文键是 `description`，`text` 是简介与技能行）。
 * 若把它整句锁死，本条链在真实解析出的简历上**无处可改**，4.5-01 的"输出定制内容"会退化成只重排顺序，
 * 而 4.5-08 的"不许把「提升 20%」写成「大幅提升」"更是永远不会触发——那条规则要防的正是"这句可以被改写"。
 *
 * 所以这里按 spec 的两轨读法收：散文键可改写，但改写受**另外两条判据**约束——
 * 数值守恒（4.5-08）与具名候选回查（4.5-07）；结构事实键（`company / role / period / school / degree /
 * major`）一律不进白名单。已知残余风险：散文里"主导"改成"参与"这类**不含数与名**的弱化，三条判据都抓不到，
 * 它由 4.5-11 的逐项人工接受 / 回退兜底——这也是 spec 把接受动作放在界面而不是让机器自动入库的原因。
 */
export const GENERATION_EDITABLE_KEYS = ['text', 'achievement', 'description'] as const;

/**
 * 生成腿可以**提议改写**的区块种类（比校验面小一圈）。
 *
 * `skills` 刻意不在内：技能行不是"描述性文字"，而让它进生成腿等于开一条最贵的虚构通道——
 * 模型往技能行里加一个库里没有的「Rust」，具名回查（只认机构后缀形态）与数值守恒都拦不住。
 * 技能在 4.2 里本来就是一条一个 id 的独立实体，要改该走知识库的实体编辑，用户当面确认。
 * 联系资料（`profile`）不是区块字段，天然不在面上。
 */
const GENERATION_TARGET_SECTION_KINDS: readonly SectionKind[] = [
  'summary',
  'experience',
  'project',
  'campus',
  'education',
];

/** 基线里能当作「已知具名实体」的字段键——公司名与学校名。 */
const KNOWN_NAME_KEYS = ['company', 'school'] as const;

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

/** 一个可改写位置：定位到「区块 id + 条目 id + 字段键」，加它当前的文本。 */
export interface GenerationField {
  readonly sectionId: string;
  readonly entryId: string;
  readonly fieldKey: string;
  readonly text: string;
}

/**
 * 取文档里所有"生成轨可改写"字段的 (条目, 字段) 组合。
 *
 * 两个调用方共用：本文件的数值 / 具名两条判据（`verifyGeneration`），以及 `resume.generate` 拼提示词与
 * 采纳改写时的目标面。**必须是同一个函数**——校验遍历的面比递给模型的面小，就等于留了一个
 * "模型可以改、校验器不看"的口子（4.5-07 的强保证会在那一刻变成假话）。
 * @param document 待遍历的文档（基线或候选各调一次，遍历口径必须一致，否则两条腿比的不是同一段文字）
 * @param editableKeys 可改写键白名单，省略时用 `GENERATION_EDITABLE_KEYS`
 * @param sectionKinds 只收这些区块种类；省略时**收全部区块**（校验面要比提议面广：技能行不许生成腿改，
 *        但万一被改了仍要按数值与具名两条判据检一遍，不许出现"改了没人看"的位置）
 * @returns 位置与文本的列表，顺序为区块 → 条目 → 字段（进提示词的编号因此稳定）
 */
export function generationEditableFields(
  document: ResumeDocument,
  editableKeys: readonly string[] = GENERATION_EDITABLE_KEYS,
  sectionKinds?: readonly SectionKind[],
): GenerationField[] {
  const fields: GenerationField[] = [];
  for (const section of document.sections) {
    if (sectionKinds !== undefined && !sectionKinds.includes(section.kind)) continue;
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
 * 生成腿这一趟**被允许提议改写**的位置（`generationEditableFields` 的子集，理由见
 * `GENERATION_TARGET_SECTION_KINDS` 与 `GENERATION_EDITABLE_KEYS` 两处注释）。
 *
 * 服务层拿它做两件事：拼提示词里的"待改写清单"，以及**只采纳落在这份清单里的模型回答**——
 * 位置不在清单上就整条丢弃（判据六的结构面：没有新增条目 / 新增字段的通道）。
 * @param document 基线文档
 * @returns 可提议改写的位置与当前文本
 */
export function generationTargetFields(document: ResumeDocument): GenerationField[] {
  return generationEditableFields(document, GENERATION_EDITABLE_KEYS, GENERATION_TARGET_SECTION_KINDS);
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
    generationEditableFields(input.original, editableKeys).map((field) => [
      `${field.sectionId}#${field.entryId}#${field.fieldKey}`,
      field.text,
    ]),
  );
  const numberFindings: NumberFinding[] = [];
  const entityFindings: EntityFinding[] = [];
  const knownNames = collectKnownNames(input.original);
  for (const field of generationEditableFields(input.proposed, editableKeys)) {
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
