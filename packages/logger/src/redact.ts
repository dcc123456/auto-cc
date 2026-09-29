/**
 * 日志脱敏（spec 1.3-11 / AGENTS.md §8.5）。
 *
 * 两条路径都要覆盖：结构化字段（`{ token: '...' }`）与自由文本（`"登录失败 token=abc"`），
 * 后者更常见也更危险——主进程报错信息通常是拼出来的字符串。
 */

const SECRET_KEY =
  /(?:^|_)(?:token|cookie|password|passwd|secret|authorization|apikey|api_key|accesskey|access_key|sessionkey|session_key)(?:$|_)/i;
const PHONE_KEY = /(?:phone|mobile|tel)/i;
const ID_CARD_KEY = /(?:idcard|id_card|identity|national_id)/i;
const EMAIL_KEY = /email|mail/i;

/** 键名可能带引号（`"Authorization": "..."`），分隔符前的闭合引号必须一起吃掉，否则 JSON 形式的整行日志漏脱敏。 */
const INLINE =
  /\b(token|cookie|password|passwd|secret|authorization|api[_-]?key|access[_-]?key|session[_-]?key|phone|mobile|tel|id[_-]?card|email)\b(\s*["']?\s*[:=]\s*)(?:"([^"]*)"|'([^']*)'|([^\s,;}\]]+))/gi;

/** 手机号只留前三后四，身份证只留后四，邮箱只留首字母与域名——够定位问题，不够冒用身份。 */
function maskByKind(kind: 'secret' | 'phone' | 'id' | 'email', value: string): string {
  if (value === '') return value;
  if (kind === 'phone') return value.length > 7 ? `${value.slice(0, 3)}****${value.slice(-4)}` : '****';
  if (kind === 'id') return value.length > 4 ? `**********${value.slice(-4)}` : '****';
  if (kind === 'email') {
    const [local = '', domain = ''] = value.split('@');
    return domain === '' ? '****' : `${local.slice(0, 1)}***@${domain}`;
  }
  return '***';
}

function classifyKey(key: string): 'secret' | 'phone' | 'id' | 'email' | undefined {
  if (SECRET_KEY.test(key)) return 'secret';
  if (PHONE_KEY.test(key)) return 'phone';
  if (ID_CARD_KEY.test(key)) return 'id';
  if (EMAIL_KEY.test(key)) return 'email';
  return undefined;
}

export function redactText(text: string): string {
  return text.replace(INLINE, (_match, key: string, sep: string, dq?: string, sq?: string, bare?: string) => {
    const kind = classifyKey(key) ?? 'secret';
    if (dq !== undefined) return `${key}${sep}"${maskByKind(kind, dq)}"`;
    if (sq !== undefined) return `${key}${sep}'${maskByKind(kind, sq)}'`;
    return `${key}${sep}${maskByKind(kind, bare ?? '')}`;
  });
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
