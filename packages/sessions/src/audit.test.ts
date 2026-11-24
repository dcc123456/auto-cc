/**
 * 人那一路的会话挂载审计（10.12-12）。
 *
 * 本文件不启动 Electron、不发起任何网络请求：`electron.session` 被换成本地 cookie 替身，
 * `shell` 只记录交给它的挂载地址，`ctx.logger.info` 用 spy 收成可读证据。
 * `runAsUserCall` 只模拟网关打的标；主进程直调仍必须被 `INVALID_ARGUMENT` 拒掉。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asApp, Context, runAsUserCall, Service, type Fiber } from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { StoreService } from '@auto-cc/plugin-store';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { SessionsService } from './index.js';

/** 一个只读 cookie 的假分区：没有网络、没有 cookie 文件，读到的永远是空清单。 */
const fakeElectron = vi.hoisted(() => ({
  partition: {
    cookies: {
      get: () => Promise.resolve([]),
      set: () => Promise.resolve(),
    },
    isPersistent: () => true,
    getStoragePath: () => null,
    clearStorageData: () => Promise.resolve(),
  },
}));

vi.mock('electron', () => ({
  app: { whenReady: () => Promise.resolve() },
  session: { fromPartition: () => fakeElectron.partition },
}));

const hostSchema = z.strictObject({});

/** 壳层宿主替身：只记挂载，不创建窗口，也不装载 URL。 */
class FakeKernelHostService extends Service {
  static provide = 'shell';
  static Config = hostSchema;

  /** 每次挂载的 `{分区, 地址}`，供断言「人那一路没有被自动化闸误拦」。 */
  readonly mounts: { partition: string; url: string }[] = [];

  /** 打开后让挂载抛错，用来验证「请求审计先于挂载结果」。 */
  failMounts = false;

  private partition = '';

  constructor(ctx: Context, _options: z.output<typeof hostSchema>) {
    super(ctx, 'shell');
  }

  /** @param partition 目标分区 @param url 目标地址（只记录，不加载） */
  mountKernelSite = (partition: string, url: string): void => {
    if (this.failMounts) throw new Error('MOUNT_FAILED');
    this.partition = partition;
    this.mounts.push({ partition, url });
  };

  /** @returns 会话服务要读的那一个分区字段 */
  getStatus = (): { kernelViewPartition: string } => ({ kernelViewPartition: this.partition });
}

const fibers: Fiber[] = [];
const tempDirs: string[] = [];

/**
 * 起一套真实 `sessions` + 本地 store + 假宿主。
 * @param startUrl 唯一测试平台的起始地址（可以带 query，用来证明审计不把它落进去）
 * @returns 会话服务、INFO spy 与宿主的挂载清单
 */
async function bootSessions(startUrl: string) {
  const ctx = new Context();
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-session-audit-'));
  tempDirs.push(dir);
  fibers.push(await ctx.plugin(ConfigService, { appName: 'auto-cc' }));
  fibers.push(await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' }));
  fibers.push(await ctx.plugin(FakeKernelHostService, {}));
  fibers.push(
    await ctx.plugin(SessionsService, {
      platforms: [
        {
          id: 'demo',
          startUrl,
          authCookieNames: [],
          guestCookieNames: [],
          authMinPresence: 1,
        },
      ],
      allowRealAutomation: false,
    }),
  );
  const info = vi.spyOn(ctx.logger, 'info').mockImplementation(() => undefined);
  const host = ctx.get('shell') as unknown as FakeKernelHostService;
  return { sessions: asApp(ctx).sessions, info, mounts: host.mounts, host };
}

/** 只取审计行，不把挂载/迁移等正常日志混进判据。 */
function auditLines(info: ReturnType<typeof vi.spyOn>): string[] {
  return info.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.startsWith('人请求把内核视图挂到非回环主机：'));
}

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('人那一路的会话挂载审计（10.12-12）', () => {
  it('非回环挂载记且只记一条脱敏 INFO，挂载行为不被自动化闸拦', async () => {
    const startUrl = 'https://example.test/login?next=secret&query=private';
    const { sessions, info, mounts } = await bootSessions(startUrl);
    try {
      await runAsUserCall(async () => await sessions.openFromUser('demo'));
      const audit = auditLines(info);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toContain('source=user');
      expect(audit[0]).toContain('platform=demo');
      expect(audit[0]).toContain('host=example.test');
      expect(audit[0]).toMatch(/at=\d+/u);
      expect(audit[0]).not.toContain('query=');
      expect(audit[0]).not.toContain('secret');
      expect(mounts).toHaveLength(1);
      expect(mounts[0]?.url).toBe(startUrl);
    } finally {
      info.mockRestore();
    }
  });

  it('回环挂载不产生审计行', async () => {
    const { sessions, info, mounts } = await bootSessions('http://127.0.0.1:10233/chat?targetId=1001');
    try {
      await runAsUserCall(async () => await sessions.openFromUser('demo'));
      expect(auditLines(info)).toEqual([]);
      expect(mounts).toHaveLength(1);
    } finally {
      info.mockRestore();
    }
  });

  it('后续挂载失败也仍留一条请求审计，不写成已挂载成功', async () => {
    const { sessions, info, mounts, host } = await bootSessions('https://example.test/fail?query=secret');
    host.failMounts = true;
    try {
      await expect(runAsUserCall(async () => await sessions.openFromUser('demo'))).rejects.toThrow('MOUNT_FAILED');
      const audit = auditLines(info);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toContain('source=user');
      expect(audit[0]).toContain('host=example.test');
      expect(audit[0]).toMatch(/at=\d+/u);
      expect(audit[0]).not.toContain('query=');
      expect(mounts).toEqual([]);
    } finally {
      info.mockRestore();
    }
  });

  it('主进程没有网关标时仍 INVALID_ARGUMENT，且不挂载也不记审计', async () => {
    const { sessions, info, mounts } = await bootSessions('https://example.test/');
    try {
      await expect(sessions.openFromUser('demo')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(mounts).toEqual([]);
      expect(auditLines(info)).toEqual([]);
    } finally {
      info.mockRestore();
    }
  });
});
