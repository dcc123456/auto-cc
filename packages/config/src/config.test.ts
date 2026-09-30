/**
 * 配置服务装配测试（spec 1.3-02 / 1.3-03）。
 *
 * 分层合并本身在 `merge.test.ts` 里已按纯函数验证过；这里要验证的是「装上服务之后，
 * 四层顺序、来源可追溯、非法字段在挂载期就被挡下」这些只有服务才提供的行为。
 */
import { Context } from '@auto-cc/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConfigService, type DataPaths } from './index.js';
import { ConfigValidationError } from './validate.js';

const LoggerConfig = z.strictObject({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  buffer: z.number().int().positive().default(500),
});

const ENV_MAP = { level: 'AUTOCC_LOG_LEVEL' };

async function mounted(
  env: Record<string, string | undefined> = {},
  paths?: Partial<DataPaths>,
): Promise<ConfigService> {
  const ctx = new Context();
  await ctx.plugin(ConfigService, { appName: 'auto-cc', ...(paths ? { paths } : {}) });
  const config = ctx.get('config') as unknown as ConfigService;
  config.env = env;
  return config;
}

describe('config 服务（四层配置）', () => {
  it('按 default < file < env < runtime 的顺序记录来源', async () => {
    const config = await mounted({ AUTOCC_LOG_LEVEL: 'warn' });
    config.setFile('logger', { level: 'info', buffer: 10 });
    config.setRuntime('logger', { buffer: 50 });

    const trace = config.trace('logger', { schema: LoggerConfig, envMap: ENV_MAP });
    expect(trace.layers.map((layer) => layer.scope)).toEqual(['default', 'file', 'env', 'runtime']);
    expect(trace.layers[1]?.values).toEqual({ level: 'info', buffer: 10 });
    expect(trace.layers[2]?.values).toEqual({ level: 'warn' });
    expect(trace.value).toEqual({ level: 'warn', buffer: 50 });
  });

  it('白名单外的环境变量一律忽略', async () => {
    const config = await mounted({ AUTOCC_LOG_LEVEL_NOT_A_KEY: 'error', LOG_LEVEL: 'error' });
    config.setFile('logger', { level: 'info' });
    expect(config.resolve('logger', { schema: LoggerConfig, envMap: ENV_MAP }).level).toBe('info');
  });

  it('运行时覆盖是补丁而不是整层替换', async () => {
    const config = await mounted();
    config.setFile('logger', { level: 'debug', buffer: 10 });
    config.setRuntime('logger', { buffer: 99 });
    expect(config.resolve('logger', { schema: LoggerConfig, envMap: ENV_MAP })).toEqual({ level: 'debug', buffer: 99 });
  });

  it('非法字段在挂载期就报错并点名路径', async () => {
    const config = await mounted();
    config.setFile('logger', { level: 'verbose' });
    expect(() => config.resolve('logger', { schema: LoggerConfig, envMap: ENV_MAP })).toThrow(ConfigValidationError);
    try {
      config.resolve('logger', { schema: LoggerConfig, envMap: ENV_MAP });
    } catch (error) {
      expect((error as ConfigValidationError).issues.map((issue) => issue.path)).toEqual(['level']);
    }
  });

  it('目录解析：主进程给过 paths 就以它为准，否则按 appName 走平台规范目录', async () => {
    // 这条断言要看的是真实环境变量下的解析结果，所以不能像上面几个用例那样替换 env 快照。
    const config = await mounted(process.env);
    const platform = config.paths();
    expect(platform.userDataDir.replaceAll('\\', '/')).toContain('auto-cc');
    expect(platform.logDir.replaceAll('\\', '/')).toContain('auto-cc');

    const override: DataPaths = { userDataDir: '/tmp/x', logDir: '/tmp/x/logs' };
    expect((await mounted(process.env, override)).paths()).toEqual(override);
  });

  it('config 自身的 schema 也走同一套严格校验', async () => {
    const ctx = new Context();
    await expect(ctx.plugin(ConfigService, { appName: '' })).rejects.toThrow(/appName/);
  });
});
