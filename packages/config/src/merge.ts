/**
 * 配置分层合并（spec 1.3-02 + 7.1-05）：默认 < 文件 < 持久层 < 环境变量 < 运行时覆盖。
 *
 * 纯函数、不读磁盘也不碰 process，因此三端行为可用单测覆盖，
 * 挂载期的 IO 留给 `@auto-cc/plugin-config` 的 service 部分。
 */

export type ConfigScope = 'default' | 'file' | 'persisted' | 'env' | 'runtime';

export interface ConfigLayer {
  scope: ConfigScope;
  values: Record<string, unknown>;
}

/** 数组与标量整体替换，只有普通对象逐键递归——避免「文件里两条、env 里一条」合并出无法预期的列表。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function mergeDeep(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = result[key];
    result[key] = isPlainObject(existing) && isPlainObject(value) ? mergeDeep(existing, value) : value;
  }
  return result;
}

/** 按数组顺序依次覆盖，后面的层赢。 */
export function mergeLayers(layers: readonly ConfigLayer[]): Record<string, unknown> {
  return layers.reduce<Record<string, unknown>>((acc, layer) => mergeDeep(acc, layer.values), {});
}

/**
 * 按 `a.b.0` 形式写入嵌套路径，中间缺失的对象/数组自动补。
 *
 * 数组也按 `Record<string, unknown>` 读写（`list['0'] = x` 与 `list[0] = x` 等价），
 * 这样游标全程只有一种类型，不必在每个分支上对 union 做 cast。
 */
export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  if (segments.length === 0 || segments.some((s) => s === '')) throw new Error(`非法配置路径：${path}`);
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i] as string;
    const next = segments[i + 1] as string;
    const existing = cursor[segment];
    if (isPlainObject(existing) || Array.isArray(existing)) {
      cursor = existing as Record<string, unknown>;
      continue;
    }
    // 下一段是数字就补数组，否则补对象；数组按字符串下标寻址即可，见函数注释。
    const holder: unknown = /^\d+$/.test(next) ? [] : {};
    cursor[segment] = holder;
    cursor = holder as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1] as string] = value;
}

/**
 * 环境变量值先按 JSON 解析，失败再退回字符串：
 * `AUTOCC_STORE_TIMEOUT=5000` 要落成正数而不是 "5000"，schema 校验才不会误报类型。
 */
export function parseEnvValue(raw: string): unknown {
  if (raw === '') return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/**
 * 把白名单里的环境变量转成一层配置。
 * @param env 环境变量表
 * @param map 配置路径 → 环境变量名；不在 map 里的变量一律忽略，避免任意键注入
 */
export function envLayer(
  env: Record<string, string | undefined>,
  map: Record<string, string>,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [path, name] of Object.entries(map)) {
    const raw = env[name];
    if (raw !== undefined) setPath(values, path, parseEnvValue(raw));
  }
  return values;
}
