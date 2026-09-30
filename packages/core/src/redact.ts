/**
 * 个人信息脱敏（spec 1.3-11 / 2.7-07 / AGENTS.md §8.5）——**全项目唯一的一份正则**。
 *
 * 放在 `core`（L0）而不是 `logger`：脱敏要落到的地方不止日志出口，还有工作流的失败证据
 * （落盘文本）与截图遮罩（注入页面的脚本），而这两处分别在 L3 与 L2，让下层反向依赖
 * `logger` 会打破 AGENTS.md §4.1 的依赖方向。判据形状只有一份，三个使用者共用（§2.1）。
 *
 * 两条路径都要覆盖：结构化字段（`{ token: '...' }`）与自由文本（`"登录失败 token=abc"`），
 * 后者更常见也更危险——主进程报错信息通常是拼出来的字符串。
 *
 * 1.3 只有**键值形态**（`phone=138...`），它能命中日志却命中不了 JD 正文：页面上的联系方式
 * 是裸值（`联系人手机：13800138000`，中文冒号 + 无英文键名），因此在 2.7-07 补上**值形态**
 * 判据。值形态只认手机号 / 证件号 / 邮箱三类，宁可漏也不要把薪资数字遮成 `****`——
 * 反过来误伤的那一条已知限制写在 spec 的验收记录里（`hotel: xxx` 这类英文键名会被键值形态吃掉）。
 */

const SECRET_KEY =
  /(?:^|_)(?:token|cookie|password|passwd|secret|authorization|apikey|api_key|accesskey|access_key|sessionkey|session_key)(?:$|_)/i;
const PHONE_KEY = /(?:phone|mobile|tel)/i;
const ID_CARD_KEY = /(?:idcard|id_card|identity|national_id)/i;
const EMAIL_KEY = /email|mail/i;

/**
 * 键名可能带引号（`"Authorization": "..."`），分隔符前的闭合引号必须一起吃掉，否则 JSON 形式的整行日志漏脱敏。
 *
 * 关键词两侧允许 `[_-]` 拼接的前后缀：cookie 名本来就是 `autocc_session` 这种带下划线的整串，
 * 用 `\b` 卡词边界会一个都不命中（`\b` 把下划线当词字符）。1.8-05 要求会话值不出现在日志里，
 * 所以除了 `session_key`，光秃秃的 `session` 也算敏感键。
 */
const INLINE =
  /(\w*[_-]?)?(token|cookie|password|passwd|secret|authorization|api[_-]?key|access[_-]?key|session[_-]?key|session|phone|mobile|tel|id[_-]?card|email)([_-]?\w*)?(\s*["']?\s*[:=]\s*)(?:"([^"]*)"|'([^']*)'|([^\s,;}\]]+))/gi;

/** 值形态判据的类别。截图遮罩按同一批类别盖块，所以两边共用这个联合。 */
export type PiiKind = 'phone' | 'id' | 'email';

/** 一条值形态判据：`source` 是**未编译**的正则源码字符串，因为注入页面的脚本只能带源码过去。 */
export type PiiValuePattern = { kind: PiiKind; source: string; flags: string };

/**
 * 值形态判据（spec 2.7-07）。
 *
 * 前后都挂环视，是为了**不吃半个号**：`薪资 15000-25000` 里的 `15000` 开头是 1、第二位是 5，
 * 单看 `1[3-9]\d{9}` 会想往里咬，`(?<![\dX])` / `(?!\d)` 把它挡在门外；证件号同理，
 * 第 19 位还是数字或校验位 `X` 时才算一整串。邮箱不带环视——`@` 本身就是足够强的边界。
 * 顺序是「长的先试」：18 位证件号若先跑手机号那条，可能留下被遮了一半的残串。
 */
export const PII_VALUE_PATTERNS: readonly PiiValuePattern[] = Object.freeze([
  { kind: 'id', source: String.raw`(?<![\dX])\d{17}[\dX](?![\dX])`, flags: 'gi' },
  { kind: 'phone', source: String.raw`(?<![\dX])1[3-9]\d{9}(?!\d)`, flags: 'g' },
  { kind: 'email', source: String.raw`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`, flags: 'g' },
]);

/** 手机号只留前三后四，身份证只留后四，邮箱只留首字母与域名——够定位问题，不够冒用身份。 */
function maskByKind(kind: 'secret' | PiiKind, value: string): string {
  if (value === '') return value;
  if (kind === 'phone') return value.length > 7 ? `${value.slice(0, 3)}****${value.slice(-4)}` : '****';
  if (kind === 'id') return value.length > 4 ? `**********${value.slice(-4)}` : '****';
  if (kind === 'email') {
    const [local = '', domain = ''] = value.split('@');
    return domain === '' ? '****' : `${local.slice(0, 1)}***@${domain}`;
  }
  return '***';
}

function classifyKey(key: string): 'secret' | PiiKind | undefined {
  if (SECRET_KEY.test(key)) return 'secret';
  if (PHONE_KEY.test(key)) return 'phone';
  if (ID_CARD_KEY.test(key)) return 'id';
  if (EMAIL_KEY.test(key)) return 'email';
  return undefined;
}

/** 键值形态命中后按键名分类掩码；键名认不出来就按最严的 secret 收。 */
function maskKeyValue(
  _match: string,
  prefix: string | undefined,
  keyword: string,
  suffix: string | undefined,
  sep: string,
  dq?: string,
  sq?: string,
  bare?: string,
): string {
  const key = `${prefix ?? ''}${keyword}${suffix ?? ''}`;
  const kind = classifyKey(key) ?? 'secret';
  if (dq !== undefined) return `${key}${sep}"${maskByKind(kind, dq)}"`;
  if (sq !== undefined) return `${key}${sep}'${maskByKind(kind, sq)}'`;
  return `${key}${sep}${maskByKind(kind, bare ?? '')}`;
}

/**
 * 把一段自由文本里的个人信息掩码掉：先按**键值形态**（`token=abc`），再按**值形态**（裸手机号）。
 *
 * 顺序不能反：键值形态会把 `phone=13800001111` 收成 `phone=138****1111`，
 * 反过来先跑值形态就得到 `phone=138****1111`，键名那一位的语义（谁被遮了）就丢了。
 * 两次替换都幂等——掩码结果里不含数字串，不会被下一轮再咬一次。
 * @param text 原始文本（日志行、证据正文、报错信息）
 * @returns 掩码后的文本；不含个人信息时原样返回
 */
export function redactText(text: string): string {
  let output = text.replace(INLINE, maskKeyValue);
  for (const pattern of PII_VALUE_PATTERNS) {
    // 每次新建 RegExp：模块级常量带 /g 会有 lastIndex 残留，跨调用串味是这类正则最隐蔽的坑。
    const re = new RegExp(pattern.source, pattern.flags);
    output = output.replace(re, (hit) => maskByKind(pattern.kind, hit));
  }
  return output;
}

/** 深拷贝式脱敏：只改需要改的分支，返回值与入参同构。 */
export function redactValue<T>(value: T, keyHint?: string): T {
  const kind = keyHint === undefined ? undefined : classifyKey(keyHint);
  if (kind !== undefined && typeof value === 'string') return maskByKind(kind, value) as unknown as T;
  if (kind !== undefined && value !== undefined && value !== null && typeof value !== 'object') {
    return maskByKind(kind, String(value)) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((item: unknown) => redactValue(item)) as unknown as T;
  if (typeof value === 'string') return redactText(value) as unknown as T;
  if (value !== null && typeof value === 'object' && (value as object).constructor === Object) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = redactValue(item, key);
    }
    return output as unknown as T;
  }
  return value;
}

export const redact = redactValue;
