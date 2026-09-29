/**
 * 日志服务装配测试（spec 1.3-04 / 1.3-05 / 1.3-11）。
 *
 * 断言都打在「插件直接调用 cordis 的 `ctx.logger`」这条真实路径上：本服务不接管调用点，
 * 只在出口接管。所以只要出口同时满足级别过滤、脱敏、缓冲与落盘，就说明绕开本服务也漏不出东西。
 */
import { asApp, Context, type Fiber } from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LogService, type LogLine } from './index.js';

const sandboxes: string[] = [];
const opened: Fiber[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  sandboxes.push(dir);
  return dir;
}

afterAll(async () => {
  // 卸载会走 effect：先摘 exporter、再 end 写流，然后才删目录，否则 Windows 上句柄未释放。
  for (const fiber of opened) await fiber.dispose();
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

interface LoggerOptions {
  level?: 'error' | 'warn' | 'info' | 'debug';
  buffer?: number;
  file?: string;
  redact?: boolean;
}

async function mounted(options: LoggerOptions = {}) {
  const dir = tempDir('auto-cc-log-');
  const ctx = new Context();
  await ctx.plugin(ConfigService, { appName: 'auto-cc' });
  asApp(ctx).config.setPathsOverride({ logDir: dir });
  const fiber = ctx.plugin(LogService, {
    level: options.level ?? 'info',
    buffer: options.buffer ?? 500,
    file: options.file ?? 'auto-cc.log',
    redact: options.redact ?? true,
  });
  await fiber;
  opened.push(fiber);
  return { ctx, fiber, log: asApp(ctx).log, dir };
}

/** 写流是异步建文件、异步落盘的，轮询比固定 sleep 更不容易在 CI 上抖。 */
async function fileText(file: string, contains: string): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (text.includes(contains)) return text;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return readFileSync(file, 'utf8');
}

function text(lines: LogLine[]): string {
  return lines.map((line) => line.text).join('\n');
}

describe('log 服务（出口接管）', () => {
  it('级别过滤生效：info 以下不进缓冲（spec 1.3-04）', async () => {
    const { ctx, log } = await mounted({ level: 'info' });
    ctx.logger.debug('调试细节 token=debug-secret');
    ctx.logger.info('普通信息');
    ctx.logger.error('出错了');
    const captured = text(log.tail());
    expect(captured).toContain('普通信息');
    expect(captured).toContain('出错了');
    expect(captured).not.toContain('调试细节');
  });

  it('free text 与结构化字段一起脱敏（spec 1.3-11）', async () => {
    const { ctx, log } = await mounted();
    ctx.logger.warn('登录失败 token=abc123456', {
      authorization: 'Bearer x.y.z',
      phone: '13800001111',
      email: 'zhangsan@qq.com',
    });
    const captured = text(log.tail());
    expect(captured).not.toContain('abc123456');
    expect(captured).not.toContain('x.y.z');
    expect(captured).not.toContain('13800001111');
    expect(captured).not.toContain('zhangsan@qq.com');
    expect(captured).toContain('138****1111');
    expect(captured).toContain('z***@qq.com');
  });

  it('Error 参数展开成堆栈文本而不是 {}，且同样脱敏', async () => {
    const { ctx, log } = await mounted();
    ctx.logger.error(new Error('上传失败 password=hunter2'));
    const captured = text(log.tail());
    expect(captured).toContain('上传失败');
    expect(captured).toContain('Error');
    expect(captured).not.toContain('hunter2');
  });

  it('按配置的目录与文件名落盘，行首带 ISO 时间、级别与来源（spec 1.3-05）', async () => {
    const { ctx, log, dir } = await mounted({ file: 'app.log' });
    ctx.logger.info('落盘验证 token=secret-value');
    const file = join(dir, 'app.log');
    expect(log.filePath).toBe(file);
    const onDisk = await fileText(file, '落盘验证');
    expect(onDisk).toMatch(/^\d{4}-\d{2}-\d{2}T.*INFO \[/);
    expect(onDisk).not.toContain('secret-value');
  });

  it('缺省目录走 config 的平台规范目录（spec 1.3-05 / 1.1-11）', async () => {
    const dir = tempDir('auto-cc-log-root-');
    const ctx = new Context();
    await ctx.plugin(ConfigService, { appName: 'auto-cc' });
    asApp(ctx).config.setPathsOverride({ logDir: dir });
    await ctx.plugin(LogService, { level: 'info', buffer: 500, file: 'default-dir.log', redact: true });
    expect(asApp(ctx).log.filePath).toBe(join(dir, 'default-dir.log'));
  });

  it('内存缓冲只保留最近 N 条（spec 1.3-04）', async () => {
    const { ctx, log } = await mounted({ buffer: 3 });
    for (const index of [1, 2, 3, 4, 5]) ctx.logger.info(`第 ${String(index)} 条`);
    const lines = log.tail();
    expect(lines.map((line) => line.text)).toEqual(['第 3 条', '第 4 条', '第 5 条']);
  });

  it('关闭脱敏时原样写出（脱敏是可关的，不是强制掩盖）', async () => {
    const { ctx, log } = await mounted({ redact: false });
    ctx.logger.warn('明文 token=plain-value');
    expect(text(log.tail())).toContain('plain-value');
  });

  it('每条日志同时发 `log/line` 事件，1.4 网关节据此推给渲染层', async () => {
    const { ctx, log } = await mounted();
    const pushed: LogLine[] = [];
    ctx.on('log/line', (line: LogLine) => pushed.push(line));
    ctx.logger.info('事件外发');
    expect(pushed.map((line) => line.text)).toEqual(['事件外发']);
    expect(pushed[0]?.level).toBe('info');
    expect(log.tail().map((line) => line.text)).toContain('事件外发');
  });

  it('插件卸载后出口摘除，不再往文件里写（effect 生命周期）', async () => {
    const { ctx, fiber, log, dir } = await mounted({ file: 'dispose.log' });
    ctx.logger.info('卸载前');
    await fileText(join(dir, 'dispose.log'), '卸载前');
    await fiber.dispose();
    ctx.logger.info('卸载后');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const onDisk = readFileSync(join(dir, 'dispose.log'), 'utf8');
    expect(onDisk).toContain('卸载前');
    expect(onDisk).not.toContain('卸载后');
    // 缓冲是内存里的历史，不随卸载清空：界面仍然能回看最后几条。
    expect(log.tail().map((line) => line.text)).toContain('卸载前');
  });
});
