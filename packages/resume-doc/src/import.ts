/**
 * 外部 / 旧格式导入（spec 3.1-09）：容错映射，未知字段**丢弃并告警**，而非静默保留或直接判非法。
 *
 * 为什么与 `validateDocument` 是两个入口：权威校验要「非法就说不合法」，
 * 而导入的历史 JSON 往往只是多了几个我们模型里根本没有的键（旧工具留下的 `avatar_url`、`referee` 之类）。
 * 直接 strict 拒绝会让用户的老简历打不开；静默保留又会让模型里混进没人认识的字段。
 * 折中就是这里：**认识的就映射，不认识的丢掉并记一条告警**，让调用方如实告诉用户「这几项没被采用」。
 */
import {
  createEmptyDocument,
  makeField,
  type Entry,
  type Profile,
  type ResumeDocument,
  type Section,
  type SectionKind,
} from './model.js';

/** 导入告警：被丢弃的未知字段或被兜底修正的类型。 */
export interface ImportWarning {
  /** 告警类型。 */
  kind: 'unknown-field-dropped' | 'coerced';
  /** 出问题的那条路径（人读串）。 */
  path: string;
  /** 一句话说明。 */
  message: string;
}

/** 导入结果：best-effort 文档 + 逐条告警。 */
export interface ImportResult {
  document: ResumeDocument;
  warnings: ImportWarning[];
}

const SECTION_KINDS = new Set<SectionKind>(['summary', 'experience', 'education', 'skills', 'project', 'campus']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 读一个字符串字段，非字符串 / 缺失都兜底成 `fallback` 并记一条 coerced 告警。 */
function readString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  warnings: ImportWarning[],
  fallback = '',
): string {
  const raw = obj[key];
  if (typeof raw === 'string') return raw;
  if (raw !== undefined) {
    warnings.push({
      kind: 'coerced',
      path: `${path}.${key}`,
      message: `期望字符串，实际为 ${typeof raw}，已按空串兜底`,
    });
  }
  return fallback;
}

/** 读一个数值字段，非数兜底成 `fallback`。 */
function readNumber(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  warnings: ImportWarning[],
  fallback: number,
): number {
  const raw = obj[key];
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (raw !== undefined) {
    warnings.push({
      kind: 'coerced',
      path: `${path}.${key}`,
      message: `期望数字，实际为 ${typeof raw}，已回退默认 ${String(fallback)}`,
    });
  }
  return fallback;
}

/** 对某对象的未知键逐个记 dropped 告警。 */
function warnUnknownKeys(
  obj: Record<string, unknown>,
  known: readonly string[],
  path: string,
  warnings: ImportWarning[],
): void {
  const knownSet = new Set(known);
  for (const key of Object.keys(obj)) {
    if (!knownSet.has(key)) {
      warnings.push({
        kind: 'unknown-field-dropped',
        path: path === '' ? key : `${path}.${key}`,
        message: `未知字段「${key}」不在文档模型里，已丢弃`,
      });
    }
  }
}

/** 导入一个外部区块对象（携带真实 kind 给字段判锁定用）。 */
function importSection(raw: unknown, path: string, warnings: ImportWarning[]): Section | null {
  const obj = isRecord(raw) ? raw : {};
  const kind = readString(obj, 'kind', path, warnings) as SectionKind;
  if (!SECTION_KINDS.has(kind)) {
    warnings.push({ kind: 'coerced', path: `${path}.kind`, message: `区块 kind「${kind}」不是已知种类，已丢弃该区块` });
    return null;
  }
  const id = readString(obj, 'id', path, warnings) || `${path}-auto`;
  const title = readString(obj, 'title', path, warnings);
  const rawEntries = Array.isArray(obj['entries']) ? obj['entries'] : [];
  if (!Array.isArray(obj['entries']))
    warnings.push({ kind: 'coerced', path: `${path}.entries`, message: 'entries 缺失或不是数组，已按空数组处理' });
  // 字段锁定判定要用真实 kind：走带 kind 的 makeField。
  const entries: Entry[] = rawEntries.map((entryRaw, index) => {
    const entryObj = isRecord(entryRaw) ? entryRaw : {};
    const entryId =
      readString(entryObj, 'id', `${path}.entries[${String(index)}]`, warnings) ||
      `${path}.entries[${String(index)}]-auto`;
    const fields = Array.isArray(entryObj['fields']) ? entryObj['fields'] : [];
    const importedFields = fields.filter(isRecord).map((field): Entry['fields'][number] => {
      const key = readString(field, 'key', `${path}.entries[${String(index)}].fields`, warnings);
      const value = readString(field, 'value', `${path}.entries[${String(index)}].fields`, warnings);
      return makeField(kind, key, value);
    });
    warnUnknownKeys(entryObj, ['id', 'fields'], `${path}.entries[${String(index)}]`, warnings);
    return { id: entryId, fields: importedFields };
  });
  warnUnknownKeys(obj, ['id', 'kind', 'title', 'entries'], path, warnings);
  return { id, kind, title, entries };
}

/** 导入联系资料，未知键告警丢弃。 */
function importProfile(raw: unknown, warnings: ImportWarning[]): Profile {
  const obj = isRecord(raw) ? raw : {};
  const contactRaw = isRecord(obj['contact']) ? obj['contact'] : {};
  const readNullable = (key: string): string | null => {
    const value = contactRaw[key];
    if (value === undefined || value === null) return null;
    return typeof value === 'string' ? value : null;
  };
  const email = readNullable('email');
  const phone = readNullable('phone');
  const location = readNullable('location');
  warnUnknownKeys(contactRaw, ['email', 'phone', 'location'], 'profile.contact', warnings);
  // name 走带告警的 readString：数字 / 对象这类「有值但类型不对」必须显式记 coerced，而不是静默吞成空串。
  const name = readString(obj, 'name', 'profile', warnings);
  warnUnknownKeys(obj, ['name', 'contact'], 'profile', warnings);
  return { name, contact: { email, phone, location } };
}

/**
 * 把任意外部 / 旧格式 JSON 容错映射成合法文档。
 *
 * 永不抛异常：任何缺失都用默认值兜底，任何未知键都丢进 `warnings`。
 * 结果的可靠性由调用方随后跑一次 `validateDocument` 确认（导入产出恒为合法形，校验主要用于兜住逻辑错误）。
 * @param raw 未知输入（旧简历导出、第三方 JSON 等）
 * @param id 目标文档 id（导入落库前的临时 id 由调用方给定）
 * @param nowMs 更新时间戳（毫秒）
 * @returns best-effort 文档 + 逐条导入告警
 */
export function importExternal(raw: unknown, id: string, nowMs: number): ImportResult {
  const warnings: ImportWarning[] = [];
  const base = createEmptyDocument(id, nowMs);
  const obj = isRecord(raw) ? raw : {};
  if (!isRecord(raw)) {
    warnings.push({ kind: 'coerced', path: '(root)', message: '输入不是对象，已回退为空文档' });
    return { document: base, warnings };
  }

  // 兼容两种历史形状：profile 嵌套，或 name/contact 平铺在顶层。平铺时把**原始**顶层 name 交给 importProfile，
  // 好让它对「有值但类型不对」（如数字 12345）记一条 coerced，而不是在这里就把它吞掉、丢掉告警。
  const profileSource = isRecord(obj['profile']) ? obj['profile'] : { name: obj['name'], contact: obj['contact'] };
  base.profile = importProfile(profileSource, warnings);

  base.schemaVersion = readNumber(obj, 'schemaVersion', '', warnings, base.schemaVersion);

  const layoutRaw = isRecord(obj['layout']) ? obj['layout'] : null;
  if (layoutRaw) {
    const marginRaw = isRecord(layoutRaw['margin']) ? layoutRaw['margin'] : {};
    // columns 超出模型范围（1–2）时不只是静默夹住——那是「改了你的值却没告诉你」，与 3.1-09 的告警口径冲突，
    // 所以显式记一条 coerced，让调用方能如实播报「这一项被修正了」。
    const rawColumns = readNumber(layoutRaw, 'columns', 'layout', warnings, base.layout.columns);
    const clampedColumns = Math.min(2, Math.max(1, rawColumns));
    if (clampedColumns !== rawColumns) {
      warnings.push({
        kind: 'coerced',
        path: 'layout.columns',
        message: `分栏数 ${String(rawColumns)} 超出允许范围（1–2），已修正为 ${String(clampedColumns)}`,
      });
    }
    base.layout = {
      pageSize: 'A4',
      margin: {
        topMm: readNumber(marginRaw, 'topMm', 'layout.margin', warnings, base.layout.margin.topMm),
        rightMm: readNumber(marginRaw, 'rightMm', 'layout.margin', warnings, base.layout.margin.rightMm),
        bottomMm: readNumber(marginRaw, 'bottomMm', 'layout.margin', warnings, base.layout.margin.bottomMm),
        leftMm: readNumber(marginRaw, 'leftMm', 'layout.margin', warnings, base.layout.margin.leftMm),
      },
      baseFontPt: readNumber(layoutRaw, 'baseFontPt', 'layout', warnings, base.layout.baseFontPt),
      lineHeight: readNumber(layoutRaw, 'lineHeight', 'layout', warnings, base.layout.lineHeight),
      columns: clampedColumns,
    };
    warnUnknownKeys(marginRaw, ['topMm', 'rightMm', 'bottomMm', 'leftMm'], 'layout.margin', warnings);
    warnUnknownKeys(layoutRaw, ['pageSize', 'margin', 'baseFontPt', 'lineHeight', 'columns'], 'layout', warnings);
  }

  const rawSections = Array.isArray(obj['sections']) ? obj['sections'] : [];
  if (Array.isArray(obj['sections'])) {
    base.sections = rawSections
      .map((sectionRaw, index) => importSection(sectionRaw, `sections[${String(index)}]`, warnings))
      .filter((section): section is Section => section !== null);
  }

  warnUnknownKeys(
    obj,
    ['name', 'contact', 'profile', 'schemaVersion', 'layout', 'sections', 'id', 'metrics', 'updatedAt'],
    '',
    warnings,
  );
  return { document: base, warnings };
}
