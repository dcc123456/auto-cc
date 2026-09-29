/**
 * `service.method` 路径解析（spec 1.4-01 / 1.4-04）。
 *
 * 服务名本身可以带点（约定是 `域.能力`，如 `store.db`），所以不能按第一个点切：
 * `store.db.prepare` 若切成 service `store` + method `db.prepare`，就会把「服务找到了、
 * 方法找不到」误报成方法缺失。这里从**最长前缀**开始试，第一个「服务在且方法取得到」
 * 的拆分即为答案。
 */

export interface PathTarget {
  service: string;
  method: string;
}

/** 把 path 拆成候选 (service, method) 对，服务名长的排在前面。 */
export function pathCandidates(path: string): PathTarget[] {
  const segments = path.split('.');
  if (segments.length < 2 || segments.some((segment) => segment === '')) return [];
  const output: PathTarget[] = [];
  for (let take = segments.length - 1; take >= 1; take -= 1) {
    output.push({
      service: segments.slice(0, take).join('.'),
      method: segments.slice(take).join('.'),
    });
  }
  return output;
}

/**
 * 在一个服务实例上取可调用方法。
 *
 * 只查方法，不查属性：属性值（如 `store.version`）不是能力，越过白名单读它们没有意义。
 * @returns 可调用签名，取不到则为 undefined
 */
export function pickMethod(service: object, method: string): ((...args: unknown[]) => unknown) | undefined {
  if (method.includes('.')) return undefined;
  const holder = service as Record<string, unknown>;
  const handler = holder[method];
  if (typeof handler !== 'function') return undefined;
  return (handler as (...args: unknown[]) => unknown).bind(service);
}

export type Resolution =
  | { ok: true; service: string; method: string; invoke: (...args: unknown[]) => unknown }
  | { ok: false; code: 'SERVICE_NOT_FOUND' | 'METHOD_NOT_FOUND'; message: string };

/**
 * 按候选顺序找出真正可调用的一端。
 *
 * 两种失败要分开报：服务没挂载（1.3-09 的依赖缺席会走到这里）与方法不存在（写错了 path），
 * 混成一条错误会让界面说不出到底缺哪个。
 * @param path 已通过白名单校验的 `service.method`
 * @param lookup 按服务名取实例，未挂载返回 undefined
 */
export function resolveCall(path: string, lookup: (name: string) => object | undefined): Resolution {
  let sawService = false;
  for (const candidate of pathCandidates(path)) {
    const service = lookup(candidate.service);
    if (!service) continue;
    sawService = true;
    const invoke = pickMethod(service, candidate.method);
    if (invoke) return { ok: true, service: candidate.service, method: candidate.method, invoke };
  }
  return sawService
    ? { ok: false, code: 'METHOD_NOT_FOUND', message: `服务上没有可调用的方法：${path}` }
    : { ok: false, code: 'SERVICE_NOT_FOUND', message: `服务未挂载：${path.split('.')[0] ?? path}` };
}
