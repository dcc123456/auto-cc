import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConfigValidationError, formatIssuePath, validateConfig } from './validate.js';

const LoggerConfig = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']),
  buffer: z.number().int().positive(),
  sinks: z.array(z.object({ file: z.string().min(1) })),
});

describe('挂载期配置校验（spec 1.3-03）', () => {
  it('合法配置原样返回', () => {
    const value = { level: 'info', buffer: 10, sinks: [{ file: 'a.log' }] };
    expect(validateConfig('logger', LoggerConfig, value)).toEqual(value);
  });

  it('schema 默认值补齐缺省字段', () => {
    const WithDefault = z.object({ level: z.enum(['debug', 'info']).default('info') });
    expect(validateConfig('logger', WithDefault, {})).toEqual({ level: 'info' });
  });

  it('非法字段抛错并指出具体路径', () => {
    let caught: unknown;
    try {
      validateConfig('logger', LoggerConfig, { level: 'verbose', buffer: 0, sinks: [{ file: '' }] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigValidationError);
    const issues = (caught as ConfigValidationError).issues;
    expect(issues.map((issue) => issue.path).sort()).toEqual(['buffer', 'level', 'sinks[0].file']);
    expect((caught as Error).message).toContain('[logger]');
  });

  it('异步 schema 在挂载期被拒绝，而不是静默变成空配置', () => {
    const asyncSchema = { '~standard': { version: 1, vendor: 'zod', validate: () => Promise.resolve({}) } };
    expect(() => validateConfig('logger', asyncSchema as never, {})).toThrow(/同步/);
  });

  it('路径格式化覆盖数字下标与 root', () => {
    expect(formatIssuePath(undefined)).toBe('(root)');
    expect(formatIssuePath(['a', 0, { key: 'b' }])).toBe('a[0].b');
  });
});
