/**
 * 简历文档模型（spec 3.1-01 / 3.1-04 / 3.1-07）：**纯数据**，不含任何 HTML / 渲染细节（3.1-10）。
 *
 * 分层按 plan §3.1：文档 → 区块（section）→ 条目（entry）→ 字段（field）。
 * 每条字段自带 `locked` 事实锁定标记（3.1-03）——公司 / 职位 / 起止时间 / 数字成果这四类
 * 事实只允许来自 P4 知识库，生成轨不得新造或改写，故锁定语义建模在字段本身而非散落在模板里。
 *
 * 度量（`DocumentMetrics` / `Layout`）是数据的一部分：字号、行距、边距、分栏、页数都进模型，
 * 让分页结果可被 diff、可被快照引用（接 3.7），而不是只活在渲染层。
 */

/** 版面纸张——P3 只承诺 A4（简历投递标准），不做纸张枚举膨胀。 */
export type PageSize = 'A4';

/** 页边距，单位毫米（与 Word / 打印驱动一致，避免在模型里混用 px 与 pt）。 */
export interface PageMargin {
  topMm: number;
  rightMm: number;
  bottomMm: number;
  leftMm: number;
}

/**
 * 版面度量（plan §3.1「含度量」）。
 * 这些默认值来自 `DEFAULT_LAYOUT`，是「空文档 → 合法 A4 单页」这一判据（3.1-07）的来源之一：
 * 空内容 + 单栏 + 标准边距即一页。真正的像素级分页在 3.3 打印管线里回写 `metrics.pages`。
 */
export interface Layout {
  pageSize: PageSize;
  margin: PageMargin;
  /** 正文字号，单位 pt（磅），非 px——与打印语义一致。 */
  baseFontPt: number;
  /** 行距倍数（相对字号），如 1.5 表示 1.5 倍行高。 */
  lineHeight: number;
  /** 分栏数——1 或 2；模型只存意图，实际栏宽由渲染轨算。 */
  columns: number;
}

/** 事实锁定的字段类别（plan §3.1）：这四类不得由生成轨新造，只能来自知识库或被标为待确认。 */
export type FactKey = 'company' | 'role' | 'period' | 'achievement';

/**
 * 字段：条目里的一个具名值。
 * `locked` 为 true 表示它承载一条事实（对应 `factKey`），改写它会触发事实锁定校验（3.1-03）。
 */
export interface Field {
  key: string;
  value: string;
  /** 是否为事实锁定字段。 */
  locked: boolean;
  /** 事实类别；仅 `locked` 为 true 时有意义，否则为 null。 */
  factKey: FactKey | null;
}

/** 条目：一段经历 / 一条项目 / 一项技能的具体记录，由若干字段组成。 */
export interface Entry {
  /** 条目稳定 id——diff 靠它对齐「同一条记录」的增删改（3.1-06）。 */
  id: string;
  fields: Field[];
}

/**
 * 区块种类。缺失某类区块必须能正常渲染（3.1-04），所以文档里只放「实际存在」的区块，
 * 而不是给每种都留一个空占位；`sections` 的顺序即用户意图顺序，normalize / diff 都不重排。
 */
export type SectionKind = 'summary' | 'experience' | 'education' | 'skills' | 'project' | 'campus';

/** 区块：一组同类条目及其标题。 */
export interface Section {
  /** 区块稳定 id（按 kind 唯一，供 diff 对齐）。 */
  id: string;
  kind: SectionKind;
  /** 区块标题（纯文本；本地化标签由渲染轨按 kind 走 i18n，不进模型，见 3.2-06）。 */
  title: string;
  entries: Entry[];
}

/** 联系资料。全部可选——缺邮箱 / 电话不该让整份文档非法（3.1-04 的同一条容错口径）。 */
export interface Contact {
  email: string | null;
  phone: string | null;
  location: string | null;
}

/** 求职者抬头（姓名 + 联系方式）。 */
export interface Profile {
  name: string;
  contact: Contact;
}

/**
 * 文档度量：渲染回写的页数等。
 * `pages` 默认 1，是「空文档 = A4 单页起点」的模型级不变量（3.1-07）；
 * 打印管线（3.3-09）会用真实分页结果覆盖它。
 */
export interface DocumentMetrics {
  pages: number;
}

/** 简历文档根对象（生成轨 / 编辑轨共用的唯一真相源）。 */
export interface ResumeDocument {
  id: string;
  /** 模型结构版本，用于导入时的向前兼容判断（3.1-09）。 */
  schemaVersion: number;
  profile: Profile;
  layout: Layout;
  sections: Section[];
  metrics: DocumentMetrics;
  /** 最后更新时间戳（毫秒）；归一化不参与内容 hash，仅作为存储元。 */
  updatedAt: number;
}

/** 当前模型结构版本；导入旧版本时可据此做字段容错映射（3.1-09）。 */
export const RESUME_SCHEMA_VERSION = 1;

/**
 * 默认版面度量（3.1-01「度量默认值」）。
 * A4、上下 14mm / 左右 16mm、正文 10.5pt、1.5 倍行距、单栏——中文简历的常见排版基线。
 */
export const DEFAULT_LAYOUT: Layout = {
  pageSize: 'A4',
  margin: { topMm: 14, rightMm: 16, bottomMm: 14, leftMm: 16 },
  baseFontPt: 10.5,
  lineHeight: 1.5,
  columns: 1,
};

/**
 * 构造一份合法的空简历文档（3.1-07 的「模板编辑起点」）。
 * @param id 文档 id（调用方给定，存储与快照按它寻址）
 * @param nowMs 更新时间戳（毫秒），由调用方注入以保持可测的确定性
 * @returns 只带默认版面、无任何区块、页数度量为 1 的合法单页文档
 */
export function createEmptyDocument(id: string, nowMs: number): ResumeDocument {
  return {
    id,
    schemaVersion: RESUME_SCHEMA_VERSION,
    profile: { name: '', contact: { email: null, phone: null, location: null } },
    layout: DEFAULT_LAYOUT,
    sections: [],
    metrics: { pages: 1 },
    updatedAt: nowMs,
  };
}

/**
 * 判断一个字段键在指定区块种类下是否属于事实锁定字段，并给出其事实类别。
 * @param kind 区块种类
 * @param key 字段键
 * @returns 事实类别；非锁定字段返回 null
 */
export function factKeyOf(kind: SectionKind, key: string): FactKey | null {
  // 经历 / 项目 / 校园三类都可能出现「公司·职位·时间·成果」四事实；教育与技能不强绑这四类。
  if (kind === 'experience' || kind === 'project' || kind === 'campus') {
    switch (key) {
      case 'company':
        return 'company';
      case 'role':
        return 'role';
      case 'period':
        return 'period';
      case 'achievement':
        return 'achievement';
      default:
        return null;
    }
  }
  return null;
}

/**
 * 构造字段：依据区块种类与字段键自动判定是否事实锁定（3.1-03）。
 * @param kind 所属区块种类（决定哪些键被锁）
 * @param key 字段键
 * @param value 字段文本值
 * @returns 带正确 `locked` / `factKey` 的字段
 */
export function makeField(kind: SectionKind, key: string, value: string): Field {
  const fact = factKeyOf(kind, key);
  return { key, value, locked: fact !== null, factKey: fact };
}
