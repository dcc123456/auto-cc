/**
 * `conversation.store` 的落库用例（spec 2.5-07）。
 *
 * 一律打**真的 `node:sqlite`**（临时目录，不进仓库）：唯一索引去重、回滚、重启后表还在这三件事
 * mock 掉就等于没测。页面那两侧用真适配器 + 假手（`chatScript`）——本条验收要连「读到」与「记住」
 * 一起看，只喂 `record()` 会漏掉适配器与库之间那层字段名对不上的风险。
 */
import { asApp, Context, NO_CONFIG, type Fiber } from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { PlatformRegistryService } from '@auto-cc/plugin-browser';
import { StoreService } from '@auto-cc/plugin-store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CONVERSATION_MIGRATION_VERSION,
  CONVERSATION_TARGET_MIGRATION_VERSION,
  CONVERSATION_TIME_INDEX_MIGRATION_VERSION,
  ConversationStoreService,
  conversationMigration,
  conversationTargetMigration,
  conversationTimeIndexMigration,
} from './conversation-store.js';
import { BossPlatformService, loadBossKnowledgePack } from './index.js';
import {
  chatScript,
  chatUrlOf,
  createFakeAct,
  createFakePage,
  messageRow,
  StubBrowserActService,
  StubBrowserPageService,
  type PageScript,
} from './test-doubles.js';

// 本文件读的是本地仿站那份知识包（AGENTS.md §7.2）：自 P8 8.1 起缺省是上线包（真 BOSS）。
const pack = loadBossKnowledgePack({ pack: 'fixture' });
const sandboxes: string[] = [];
const fibers: Fiber[] = [];

/** 开一个系统临时目录并记账（用例结束后统一删除，AGENTS.md §7.5）。 */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-conversation-'));
  sandboxes.push(dir);
  return dir;
}

/**
 * 挂起一套 config + store + 假页面手 + 登记处 + 真 BOSS 适配器 + 会话库。
 *
 * 装配顺序是硬的：`conversation.store` 的 `syncFrom` 要在登记处里取得到适配器，而适配器要两只手都在位。
 * @param script 页面读数脚本（会话页的行由它决定）
 * @param dir 库文件目录（省略则新开一个临时目录，重启用例把同一个目录传两次）
 * @param platform 会话库的默认平台（省略为 `boss`）
 * @returns 上下文、`conversation.store`、`store` 与本次的库目录
 */
async function boot(script: PageScript, dir = tempDir(), platform = 'boss') {
  const ctx = new Context();
  fibers.push(await ctx.plugin(ConfigService, { appName: 'auto-cc' }));
  fibers.push(await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' }));
  fibers.push(await ctx.plugin(StubBrowserPageService, { fake: createFakePage(script) }));
  fibers.push(await ctx.plugin(StubBrowserActService, { fake: createFakeAct() }));
  fibers.push(await ctx.plugin(PlatformRegistryService, NO_CONFIG));
  fibers.push(await ctx.plugin(BossPlatformService, { pack: 'fixture' }));
  const conversationFiber = await ctx.plugin(ConversationStoreService, { platform });
  fibers.push(conversationFiber);
  const app = asApp(ctx);
  return { ctx, dir, store: app.store, conversation: app['conversation.store'], conversationFiber };
}

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

/**
 * 直接往库里落一条消息（不走页面：这几组用例要的是可控的 `read_at` 与可控的两格坐标，
 * 页面给的时刻那一列永远是「现在」，而仿站包没有声明会话定位、按会话坐标只能走到适配器的
 * `KNOWLEDGE_PACK_INVALID` 那一支——落库这一侧的形状只能这样喂）。
 * @param conversation 会话库句柄
 * @param jobId 岗位标识（按会话对象落库时给 `null`，裁定⑲ 之后两格只有一只非空）
 * @param at 读到的时刻毫秒，决定这行落在哪个区间里
 * @param from 发送方角色（默认招聘方；`self` 用来证明它不计进「回过话」那一级）
 * @param note 正文与去重键的种子（同一目标多条要不同的去重键，否则并成一行）
 * @param conversationTarget 会话对象标识（省略为 `null`，即按岗位那一路落的行）
 * @returns 本次是新建行（`true`）还是被去重索引拦下（`false`）
 */
function seedMessage(
  conversation: ConversationStoreService,
  jobId: string | null,
  at: number,
  from: 'recruiter' | 'self' = 'recruiter',
  note = '',
  conversationTarget: string | null = null,
): boolean {
  return conversation.record({
    platform: 'boss',
    jobId,
    conversationTarget,
    from,
    text: `方便聊聊${note}`,
    externalId: `r-${jobId ?? conversationTarget ?? 'none'}${note}`,
    at,
  });
}

describe('同步一轮会话（spec 2.5-07）', () => {
  it('页面读到几条就落几行，读数把「新增」与「已见过」分开报', async () => {
    const { conversation } = await boot(
      chatScript(pack, null, [messageRow(0), messageRow(1, { direction: 'outbound' })]),
    );
    const result = await conversation.syncFrom({ jobId: '1001' });
    expect(result).toMatchObject({ platform: 'boss', jobId: '1001', read: 2, inserted: 2, duplicate: 0 });
    expect(result.at).toBeGreaterThan(0);
    const list = conversation.list({ jobId: '1001' });
    expect(list.total).toBe(2);
    // 顺序是页面的时间线方向，不是插入的倒序：界面画时间线靠它。
    expect(list.rows.map((row) => row.from)).toEqual(['recruiter', 'self']);
    expect(list.rows[0]).toMatchObject({ jobId: '1001', externalId: 'reply-0', text: '方便聊聊吗' });
  });

  it('再同步一次一条都不新增——全量读页面是预期用法，不是异常', async () => {
    const script = chatScript(pack, null, [messageRow(0), messageRow(1)]);
    const { conversation } = await boot(script);
    await conversation.syncFrom({ jobId: '1001' });
    const second = await conversation.syncFrom({ jobId: '1001' });
    expect(second).toMatchObject({ read: 2, inserted: 0, duplicate: 2 });
    expect(conversation.status().total).toBe(2);
  });

  it('页面不给稳定 id 时，同一句话的两遍读数并成一行', async () => {
    const { conversation } = await boot(
      chatScript(pack, null, [
        messageRow(0, { externalId: null }),
        messageRow(1, { externalId: null }),
        messageRow(2, { externalId: null, text: '方便，请问期望薪资？' }),
      ]),
    );
    const result = await conversation.syncFrom({ jobId: '1001' });
    // 前两条方向 + 正文完全相同，去重键退到摘要之后就撞在一起；第三条正文不同，照落。
    expect(result).toMatchObject({ read: 3, inserted: 2, duplicate: 1 });
  });

  it('同一批消息落到不同目标上是两个线程（去重键含 job_id）', async () => {
    const { conversation, ctx } = await boot(chatScript(pack, null, [messageRow(0)]));
    await conversation.syncFrom({ jobId: '1001' });
    const second = await conversation.syncFrom({ jobId: '2002' });
    expect(second).toMatchObject({ jobId: '2002', read: 1, inserted: 1, duplicate: 0 });
    expect(conversation.status()).toMatchObject({ total: 2, jobs: 2 });
    // 地址确实跟着目标变了：`asApp(ctx)` 拿到的是那只真适配器登记过的页面手。
    expect(asApp(ctx)['platform.registry'].get('boss')).toBeTruthy();
    expect(chatUrlOf('2002')).toContain('targetId=2002');
  });

  it('目标为空时结构化失败，一次页面读取都不发', async () => {
    const { conversation } = await boot(chatScript(pack, null, [messageRow(0)]));
    await expect(conversation.syncFrom({ jobId: '   ' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      path: 'conversation.store',
    });
  });

  it('平台未登记时同步得到结构化失败而不是空结果', async () => {
    const { conversation } = await boot(chatScript(pack, null, [messageRow(0)]));
    await expect(conversation.syncFrom({ jobId: '1001' }, 'liepin')).rejects.toMatchObject({
      code: 'PLATFORM_NOT_REGISTERED',
    });
  });
});

describe('读数与钳制（spec 2.5-07）', () => {
  it('limit 钳到区间内，总数不受 limit 影响', async () => {
    const { conversation } = await boot(
      chatScript(pack, null, [messageRow(0), messageRow(1), messageRow(2, { text: '方便' })]),
    );
    await conversation.syncFrom({ jobId: '1001' });
    const capped = conversation.list({ jobId: '1001' }, 2);
    expect(capped).toMatchObject({ total: 3 });
    expect(capped.rows).toHaveLength(2);
    expect(conversation.list({ jobId: '1001' }, 0).rows).toHaveLength(1);
    expect(conversation.list({ jobId: '1001' }, 99_999).total).toBe(3);
  });

  it('概况把「招聘者发来的」与「自己发出的」分开数，并给出最近读到的目标', async () => {
    const { conversation } = await boot(
      chatScript(pack, null, [messageRow(0), messageRow(1, { direction: 'outbound' })]),
    );
    await conversation.syncFrom({ jobId: '1001' });
    expect(conversation.status()).toMatchObject({
      total: 2,
      recruiterMessages: 1,
      jobs: 1,
      // `status().schemaVersion` 读的是库上的全局水位（`PRAGMA user_version`）：本包推的三条里最高是 33。
      schemaVersion: CONVERSATION_TARGET_MIGRATION_VERSION,
      newestJobId: '1001',
    });
  });

  it('库里什么都没有时读数是零而不是报错', async () => {
    const { conversation } = await boot(chatScript(pack, null, []));
    expect(await conversation.syncFrom({ jobId: '1001' })).toMatchObject({ read: 0, inserted: 0, duplicate: 0 });
    expect(conversation.list({ jobId: '1001' })).toEqual({ total: 0, rows: [] });
    expect(conversation.status()).toMatchObject({ total: 0, recruiterMessages: 0, jobs: 0, newestJobId: null });
  });
});

describe('按会话坐标落库与读回（spec 8.4-02 的会话库半边，P8 裁定⑲）', () => {
  it('同一个稳定 id 换一条会话就是新的一行；同一条会话再读一遍仍然并成一行', async () => {
    const { conversation } = await boot(chatScript(pack, null, []));
    // 真 BOSS 的会话页没有岗位地址，按行选中之后落库的行是 `job_id='' + conversation_target=<公司名>`。
    expect(seedMessage(conversation, null, 1_000, 'recruiter', '', '示例公司')).toBe(true);
    expect(seedMessage(conversation, null, 2_000, 'recruiter', ' second', '另一个公司')).toBe(true);
    // 去重键换了格子才拦得住：这一条与第一条 `externalId` 不同，但即便相同也不该并到别的联系人身上。
    expect(
      conversation.record({
        platform: 'boss',
        jobId: null,
        conversationTarget: '示例公司',
        from: 'recruiter',
        text: '方便聊聊吗',
        externalId: 'r-示例公司',
        at: 3_000,
      }),
    ).toBe(false);
    expect(conversation.status().total).toBe(2);
  });

  it('按哪一路读的就按哪一路查：两条坐标不串成同一条时间线', async () => {
    const { conversation } = await boot(chatScript(pack, null, []));
    seedMessage(conversation, '1001', 1_000);
    seedMessage(conversation, null, 2_000, 'recruiter', '', '示例公司');
    const byJob = conversation.list({ jobId: '1001' });
    const byConversation = conversation.list({ conversationTarget: '示例公司' });
    expect(byJob.total).toBe(1);
    expect(byConversation.total).toBe(1);
    // 视图上缺的那一格如实回 null（空串只活在库里，不跨进程）。
    expect(byJob.rows[0]).toMatchObject({ jobId: '1001', conversationTarget: null });
    expect(byConversation.rows[0]).toMatchObject({ jobId: null, conversationTarget: '示例公司' });
    expect(conversation.list({ jobId: '1001', conversationTarget: '示例公司' })).toEqual({ total: 0, rows: [] });
  });

  it('目标数按两格坐标一起去重：同一个岗位名下的两条联系人算两个目标', async () => {
    const { conversation } = await boot(chatScript(pack, null, []));
    seedMessage(conversation, null, 1_000, 'recruiter', '', '示例公司');
    seedMessage(conversation, null, 1_100, 'recruiter', ' again', '示例公司');
    seedMessage(conversation, null, 1_200, 'recruiter', '', '另一个公司');
    const wholeWindow = { fromMs: 0, toMs: Number.MAX_SAFE_INTEGER };
    expect(conversation.status().jobs).toBe(2);
    // 与 `status().jobs` 同一个口径（§2.5）：漏斗的「回过话」数的是联系人，不是消息条数。
    expect(conversation.repliedJobCount(wholeWindow)).toBe(conversation.status().jobs);
  });

  it('两种坐标都没给时同步得到结构化失败，一次页面读取都不发', async () => {
    const { conversation } = await boot(chatScript(pack, null, [messageRow(0)]));
    await expect(conversation.syncFrom({ jobId: '  ', conversationTarget: ' ' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      path: 'conversation.store',
    });
  });
});

describe('迁移与重启（spec 2.5-07 的落库一半）', () => {
  it('号段是 5 / 26 / 33，且重复挂载不会在清单里留下两个同名号', async () => {
    const dir = tempDir();
    const first = await boot(chatScript(pack, null, [messageRow(0)]), dir);
    // 库上的全局水位是「已应用的最大号」，所以本包推的三条（建表 5 + 时间索引 26 + 会话坐标列 33）之后停在 33。
    expect(first.store.version).toBe(CONVERSATION_TARGET_MIGRATION_VERSION);
    await first.conversation.syncFrom({ jobId: '1001' });
    await first.conversationFiber.dispose();
    const again = await boot(chatScript(pack, null, [messageRow(0)]), dir);
    for (const version of [
      CONVERSATION_MIGRATION_VERSION,
      CONVERSATION_TIME_INDEX_MIGRATION_VERSION,
      CONVERSATION_TARGET_MIGRATION_VERSION,
    ]) {
      expect(again.store.migrations.filter((item) => item.version === version)).toHaveLength(1);
    }
    // 重启之后旧行还在：会话是「对方回了什么」的真相，不该随进程一起消失。
    expect(again.conversation.status().total).toBe(1);
    // 去重键活在索引里而不是内存里，所以重启后的第一遍同步不会把它算成新消息。
    expect(await again.conversation.syncFrom({ jobId: '1001' })).toMatchObject({ read: 1, inserted: 0, duplicate: 1 });
  });

  it('回滚把表整张丢掉，再升回来是一张空表', async () => {
    const { conversation, store } = await boot(chatScript(pack, null, [messageRow(0), messageRow(1)]));
    await conversation.syncFrom({ jobId: '1001' });
    expect(conversation.status().total).toBe(2);
    // 回到 5 之前就是把三条一起回退（建表 5 + 时间索引 26 + 会话坐标列 33），再升回来三条都重跑一遍。
    store.rollback(CONVERSATION_MIGRATION_VERSION - 1);
    store.upgrade();
    expect(store.version).toBe(CONVERSATION_TARGET_MIGRATION_VERSION);
    expect(conversation.status().total).toBe(0);
  });

  it('老库只跑到 26 时，33 把列加上、旧行归到「没有会话坐标」那一路（裁定⑲ 的升级半边）', () => {
    // 直接对一份内存库跑迁移，模拟装机用户那份「5 与 26 已记账、33 从没跑过」的库：
    // 改老迁移的 `up` 在这种库上执行不到（§9 的 5.3-a），所以这一条只能靠真 DDL 顺序来验。
    const db = new DatabaseSync(':memory:');
    conversationMigration.up(db);
    conversationTimeIndexMigration.up(db);
    db.prepare(
      `INSERT INTO conversation_messages (platform, job_id, direction, text, external_id, dedupe_key, read_at)
       VALUES ('boss', '1001', 'recruiter', '方便聊聊吗', 'reply-0', 'id:reply-0', 1)`,
    ).run();

    conversationTargetMigration.up(db);

    const old = db
      .prepare('SELECT job_id, conversation_target FROM conversation_messages WHERE external_id = ?')
      .get('reply-0') as { job_id: string; conversation_target: string };
    expect(old).toEqual({ job_id: '1001', conversation_target: '' });
    // 新索引确实带上了那一格：同 `dedupe_key` 换一条会话要能插进去。
    db.prepare(
      `INSERT INTO conversation_messages (platform, job_id, conversation_target, direction, text, external_id, dedupe_key, read_at)
       VALUES ('boss', '1001', '示例公司', 'recruiter', '方便聊聊吗', 'reply-0', 'id:reply-0', 2)`,
    ).run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversation_messages').get() as { n: number | bigint }).toEqual({
      n: 2,
    });
    // 回滚把列与旧索引形状换回来：升级前那一行不丢，而带会话坐标的行**只能一起删**——
    // 旧索引 `(platform, job_id, dedupe_key)` 装不下它们（岗位格都是空串、去重键同形），
    // 留着重建旧索引就以 `UNIQUE constraint failed` 崩在半路（本轮补片实测）。
    conversationTargetMigration.down(db);
    const left = db.prepare('SELECT job_id, external_id FROM conversation_messages').all() as unknown as {
      job_id: string;
      external_id: string;
    }[];
    expect(left).toEqual([{ job_id: '1001', external_id: 'reply-0' }]);
    db.close();
  });
});

describe('按区间数「回过话的岗位数」（spec 5.8-01 的会话库半边）', () => {
  it('数的是岗位不是消息：同一岗位两条只算一个，区间含头不含尾', async () => {
    const { conversation } = await boot(chatScript(pack, null, []));
    seedMessage(conversation, 'job-a', 2_000);
    seedMessage(conversation, 'job-a', 2_500, 'recruiter', ' second');
    seedMessage(conversation, 'job-b', 4_000);
    // 自己发出去的那条不算「对方回话」，否则这一级会被自己的打招呼灌水。
    seedMessage(conversation, 'job-c', 3_000, 'self');
    expect(conversation.repliedJobCount({ fromMs: 0, toMs: 3_000 })).toBe(1);
    expect(conversation.repliedJobCount({ fromMs: 0, toMs: 4_000 })).toBe(1);
    expect(conversation.repliedJobCount({ fromMs: 4_000, toMs: 5_000 })).toBe(1);
    expect(conversation.repliedJobCount({ fromMs: 0, toMs: 5_000 })).toBe(2);
    expect(conversation.repliedJobCount({ fromMs: 5_000, toMs: 6_000 })).toBe(0);
  });

  it('口径与 `status().jobs` 一致：同一套行两处数出同一个岗位数', async () => {
    const { conversation } = await boot(chatScript(pack, null, []));
    seedMessage(conversation, 'job-a', 2_000);
    seedMessage(conversation, 'job-a', 2_100, 'recruiter', ' again');
    seedMessage(conversation, 'job-b', 2_200);
    const wholeWindow = { fromMs: 0, toMs: Number.MAX_SAFE_INTEGER };
    // 两处都按 `platform + job_id + conversation_target` 去重、都只认招聘方（§2.5：同一件事不留第二个口径）。
    expect(conversation.repliedJobCount(wholeWindow)).toBe(conversation.status().jobs);
    expect(conversation.repliedJobCount(wholeWindow)).toBe(2);
  });

  it('号段 26 的索引在，区间查询走它而不是全表扫（spec 5.8-05 的万级计时靠它）', async () => {
    const { store } = await boot(chatScript(pack, null, []));
    const index = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='conversation_read_at'")
      .get() as { name?: string } | undefined;
    expect(index?.name).toBe('conversation_read_at');
    const plan = store.db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT COUNT(DISTINCT platform || '|' || job_id || '|' || conversation_target) FROM conversation_messages
         WHERE direction = 'recruiter' AND read_at >= ? AND read_at < ?`,
      )
      .all(0, 1) as unknown as { detail?: string }[];
    expect(plan.some((row) => /conversation_read_at/i.test(row.detail ?? ''))).toBe(true);
  });
});
