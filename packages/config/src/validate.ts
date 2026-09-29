import type { StandardSchemaV1 } from '@standard-schema/spec';

/**
 * standard-schema 适配器（spec 1.3-03）：任何实现该接口的 schema（本仓库用 zod）都能校验配置，
 * 失败时抛出带**字段路径**的错误，而不是让插件在运行期撞上空值。
 */

export interface ConfigIssue {
  path: string;
  message: string;
}

export class ConfigValidationError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(serviceName: string, issues: readonly ConfigIssue[]) {
    const detail = issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
    super(`配置校验失败 [${serviceName}] ${detail}`);
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}

/** standard-schema 的 path 允许数字下标与 `{ key }` 形式，统一成 `a.b[0].c` 便于读。 */
export function formatIssuePath(path: StandardSchemaV1.Issue['path']): string {
  if (!path || path.length === 0) return '(root)';
  let output = '';
  for (const segment of path) {
    const raw = typeof segment === 'object' && segment !== null ? String(segment.key) : String(segment);
    if (/^\d+$/.test(raw)) output += `[${raw}]`;
    else output += output === '' ? raw : `.${raw}`;
  }
  return output === '' ? '(root)' : output;
}

/**
 * 挂载期校验必须同步：cordis 的 `resolveConfig` 遇到 thenable 直接抛
 * `Async config validation is not supported`，异步 schema 拿不到我们的可读错误。
 */
export function validateConfig<Output>(
  serviceName: string,
  schema: StandardSchemaV1<unknown, Output>,
  value: unknown,
): Output {
  const result = schema['~standard'].validate(value);
  if (result instanceof Promise) throw new TypeError(`配置校验必须是同步的：${serviceName}`);
  if (result.issues) {
    throw new ConfigValidationError(
      serviceName,
      result.issues.map((issue) => ({ path: formatIssuePath(issue.path), message: issue.message })),
    );
  }
  return result.value;
}
