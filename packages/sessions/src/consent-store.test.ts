/**
 * 首次风险签字的落库用例（spec 2.7-06 的存储那一半）。
 *
 * 这里只测 `consent-store.ts` 与 store 的迁移台账：`SessionsService` 本身 import 了 `electron`
 * （分区与 cookie 观测），Node 侧挂不起来，所以它的 `grantConsent` / `consentStatus` 由
 * 真实窗口里的 harness 用例覆盖（见 plan §14.4 的 V 类条目）。
 * 三条判据值得单测：**只记第一次**（刷新等于篡改审计）、**跨重启还在**（签字不是内存里的开关）、
 * **升得上去也回得下来**（一张没有 `down` 的表在 spec 2.3-05 之后就不该进主干）。
 */
import { Context } from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { StoreService } from '@auto-cc/plugin-store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CONSENT_MIGRATION_VERSION,
  consentMigration,
  consentScope,
  readConsentAt,
  writeConsent,
} from './consent-store.js';

const sandboxes: string[] = [];

afterAll(() => {
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 句柄延迟释放时允许残渣留在系统 temp（与 store / jd-store 用例同一处置）。
    }
  }
});

/**
 * 挂一份真 store 并把签字迁移升上去。
 * @param dir 库目录；传已有目录就是演「换个进程重挂同一份库」
 * @returns store 服务与它所在的上下文（`ctx` 留给回滚之后的重读）
 */
async function boot(dir = mkdtempSync(join(tmpdir(), 'auto-cc-consent-'))) {
  sandboxes.push(dir);
  const ctx = new Context();
  await ctx.plugin(ConfigService, { appName: 'auto-cc' });
  await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' });
  const store = ctx.get('store') as unknown as StoreService;
  // 真实实现里这一步在 `sessions` 的 init 里（`ensureSchema`）：版本去重后 push，再 `upgrade()`。
  store.migrations.push(consentMigration);
  store.upgrade();
  return { ctx, store };
}

describe('签字表的迁移（spec 2.7-06）', () => {
  it('号段是 6，且不与前五张表撞号', async () => {
    const { store } = await boot();
    expect(CONSENT_MIGRATION_VERSION).toBe(6);
    expect(store.version).toBe(6);
    expect(store.migrations.filter((item) => item.version === 6)).toHaveLength(1);
  });

  it('回滚到 5 之后表整张消失，再升回来是空表', async () => {
    const { store } = await boot();
    writeConsent(store.db, 'boss', 1);
    const back = store.rollback(CONSENT_MIGRATION_VERSION - 1);
    expect(back.reverted).toEqual([CONSENT_MIGRATION_VERSION]);
    expect(store.version).toBe(5);
    expect(() => readConsentAt(store.db, 'boss')).toThrow(/no such table/);
    store.upgrade();
    expect(store.version).toBe(6);
    expect(readConsentAt(store.db, 'boss')).toBeNull();
  });
});

describe('签字记录的读写', () => {
  it('scope 由平台名拼成 automation:<platform>，一条主键就是一个风险主体', async () => {
    const { store } = await boot();
    expect(consentScope('boss')).toBe('automation:boss');
    writeConsent(store.db, 'boss', 1_760_000_000_000);
    // 直接按拼出来的 scope 查：写入口只接受平台名，这里就没有第二种键形状的容身之处。
    const row = store.db.prepare('SELECT scope, acknowledged_at FROM automation_consents').get() as unknown as {
      scope: string;
      acknowledged_at: number;
    };
    expect(row).toEqual({ scope: 'automation:boss', acknowledged_at: 1_760_000_000_000 });
  });

  it('第二次确认不刷新首次时刻（审计要回答「风险从哪一刻被承担」）', async () => {
    const { store } = await boot();
    writeConsent(store.db, 'boss', 1_760_000_000_000);
    writeConsent(store.db, 'boss', 1_800_000_000_000);
    expect(readConsentAt(store.db, 'boss')).toBe(1_760_000_000_000);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM automation_consents').get()).toEqual({ n: 1 });
  });

  it('平台之间互不串：签过 boss 不等于签过 liepin', async () => {
    const { store } = await boot();
    writeConsent(store.db, 'boss', 1);
    expect(readConsentAt(store.db, 'liepin')).toBeNull();
  });

  it('没签过读成 null 而不是抛错（界面按 null 画确认卡片）', async () => {
    const { store } = await boot();
    expect(readConsentAt(store.db, 'boss')).toBeNull();
    expect(readConsentAt(store.db, '从未登记的平台')).toBeNull();
  });

  it('重挂同一份库仍然读得到：签字是跨重启的状态，不是内存里的开关', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-cc-consent-'));
    const first = await boot(dir);
    writeConsent(first.store.db, 'boss', 1_760_000_123_456);
    // 换一次上下文 = 换一次进程：连接是新的，库是那份库。
    const second = await boot(dir);
    expect(readConsentAt(second.store.db, 'boss')).toBe(1_760_000_123_456);
  });
});
