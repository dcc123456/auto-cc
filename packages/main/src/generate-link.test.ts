/**
 * `resume.generate` 的真装配判定（spec 4.5-01 / 05 / 06 / 09 / 10 / 12 的接线半边，plan §4.5 判据二 / 三 / 五）。
 *
 * 为什么这条住在 `packages/main`（与 `gap-quota-link.test.ts` 同一个理由）：判的是**装配面**，
 * 而装配面只有在这里才同时在场——真的 `store`（要走完迁移号段才知道 15 有没有撞号）、
 * 真的 `agent.tools`（入站参数经 `safeParse`）、`resume-kb` 的三个服务与 `resume-doc` 的工作副本，
 * 以及 `@auto-cc/shared` 那份过进程边界的镜像类型。在 `resume-kb` 自己包里演一遍，
 * 替身既不会撞号、也不会拒绝畸形入参、更不会替 `shared` 的镜像漂移发红。
 *
 * 四条判定各守一种只在真装配里才会出现的失效：
 * 1. **号段 15 与同装配里的其他建表包不撞号**。`runMigrations` 在动手之前就查版本重复并抛错
 *    （`store/src/migrate.ts:91`），所以撞号的症状不是"表没建"而是**整个 store 起不来**——
 *    这条只有在把 7 / 11～14 那几个包一起装上时才判得准，包内用例那份装配里没有它们。
 * 2. **agent 入口经真注册表调得通**（`tools.call('resume.generate.run', …)`）：工具 id、参数 schema、
 *    返回体三者都要对得上，否则 4.5-c 的界面与对话两条入口会长成两套行为（§5.9）。
 * 3. **`run()` 跑完之后工作副本逐字未变**（判据三）：生成侧只有 `load()` 一条读路径，
 *    唯一的写口是 `accept()`。这条只能在真库里判——替身文档存不住"被 `save()` 过"这件事，
 *    而一次静默写回就是把用户的原始简历覆盖掉。
 * 4. **`shared` 的镜像不漂移**：把服务返回体去掉 `document` 之后赋给 `GenerationRunRowView`，
 *    编译期发红即说明两侧不同步；再过一次 `structuredClone`，因为 IPC 载荷走的是结构化克隆，
 *    带函数或带不可克隆成员的形状在单测里能通过、到进程边界才会丢。
 *
 * 下面第二组（4.5-c 的接受面）再加三条，判的都是"唯一写口"这一侧：
 * 5. **`accept()` 在真 store 里写回的是它自己复验过的那一份**，且写后的 `updated_at` 等于表态时刻；
 *    返回体能赋给 `GenerationAcceptRowResult` 并克隆得过去。
 * 6. **基线过期在真库里拦得住**：用户经 `resume.doc.save()` 自己改过简历后，旧产物接受必须以
 *    `KB_GENERATION_STALE_BASELINE` 拒绝，且库里留的仍然是用户那一版。
 * 7. **写口的可达面只有界面**：`resume.generate.accept` 在渲染层白名单里，
 *    而 `agent.tools` 的声明里没有它（对话不替用户签字），`resume.doc.save` 也不在白名单里（正文不过界）。
 *
 * 判据五（生成不接额度闸门）在这里是**结构性**成立的：这份装配里根本没有 `entitlement.*` / `usage.*`
 * 服务，而生成照样跑完——与 4.4-e1 判据三同一手法。真接付费网关那天要动的 spec 是 4.6-08，不是这里。
 *
 * 语料是文件里的虚构中文简历（§7.2 不碰真实招聘平台），手机号是假哨兵；
 * 没有装 `llm.chat`，所以模型腿报 `unavailable`、产物走 4.5-09 的仅重排保守版——
 * 这条用例判的恰恰是"没有模型时装配面不断流"，改写内容与重试的判定在包内的
 * `generate-service.test.ts` 用替身断过。
 */
import { asApp, AppError, Context, type Fiber } from '@auto-cc/core';
import { AgentToolsService } from '@auto-cc/plugin-agent';
import { ConfigService } from '@auto-cc/plugin-config';
import { LogService } from '@auto-cc/plugin-logger';
import { ResumeDocService, ResumeSnapshotService } from '@auto-cc/plugin-resume-doc';
import {
  KbGapService,
  KbProfileService,
  kbGapSchema,
  kbGenerateSchema,
  kbProfileSchema,
  parseResumeText,
  ResumeGenerateService,
  resumeParseSchema,
  ResumeParseService,
  type GenerationView,
} from '@auto-cc/plugin-resume-kb';
import { StoreService } from '@auto-cc/plugin-store';
import { isAllowedCall, type GenerationAcceptRowResult, type GenerationRunRowView } from '@auto-cc/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';

/** 虚构简历：两段经历 + 技能行，够 4.4 的词面腿命中，也够 4.5 的重排真的挪位置。 */
const CORPUS_MD = [
  '李四',
  '电话：13900007777',
  '',
  '## 教育经历',
  '南汇大学｜信息工程 本科 2016.09-2020.06',
  '',
  '## 工作经历',
  '云栖网络｜后端工程师 2020.07-2023.12',
  '- 负责结算服务的稳定性治理，把超时率下降 35%。',
  '',
  '## 技能',
  '- Java、MySQL、Redis',
  '- Kubernetes、Helm',
].join('\n');

/** 虚构 JD：词面腿命中 Kubernetes 与学历，不需要模型也能出相关性读数。 */
const JD_TEXT =
  '后端工程师（虚构：南汇云图）：负责结算链路的 Java 服务，熟悉 Kubernetes 与 Helm，本科及以上学历，3 年以上经验。';

/** 工作副本 id 与判定基准时刻（固定值，两次运行可比）。 */
const DOC_ID = 'resume-generate-link';
const AS_OF_MS = new Date(2026, 9, 15, 12).getTime();

const sandboxes: string[] = [];
const fibers: Fiber[] = [];

/**
 * 撑起「真 store + 简历文档 + 知识库 + 缺口腿 + 生成腿 + 真工具注册表」的装配。
 *
 * 挂载顺序照 `cordis.yml`：`agent` 在能力包之前（工具登记是软取，晚挂载就登记出 0 个工具），
 * `kb-generate` 排在 `kb-gap` 之后。配置一律取 schema 出厂值（与清单同源）：
 * 这里判接线，不在测试里另抄一份阈值。
 * @returns 应用句柄与这份装配用的临时目录
 */
async function bootAssembly() {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-generate-link-'));
  sandboxes.push(dir);
  const ctx = new Context();
  fibers.push(await ctx.plugin(ConfigService, { appName: 'auto-cc' }));
  fibers.push(await ctx.plugin(LogService, { level: 'info', buffer: 200, file: 'auto-cc.log', dir, redact: false }));
  fibers.push(await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' }));
  fibers.push(await ctx.plugin(ResumeDocService, {}));
  // `kb.profile` 硬注入了这两只（4.1-14 的删除腿），而清单顺序就是挂载顺序（AGENTS.md §9 的 5.1-c）：
  // 挂晚了本服务 PENDING，下面那句 `app['kb.profile']` 直接取不到。
  fibers.push(await ctx.plugin(ResumeSnapshotService, { maxSnapshots: 20 }));
  fibers.push(await ctx.plugin(ResumeParseService, resumeParseSchema.parse({})));
  fibers.push(await ctx.plugin(KbProfileService, kbProfileSchema.parse({})));
  fibers.push(await ctx.plugin(AgentToolsService, {}));
  fibers.push(await ctx.plugin(KbGapService, kbGapSchema.parse({})));
  fibers.push(await ctx.plugin(ResumeGenerateService, kbGenerateSchema.parse({})));
  const app = asApp(ctx);
  // 工作副本与知识库实体走 3.1 / 4.2 的公开入口写进来，不在这里手搓 SQL。
  // `parseResumeText` 返回可判别联合（4.1-05 的"拒绝就返回半份都没有"），所以先判一次 `status`：
  // 语料哪天解析不过，这里要当场抛错，而不是让四条用例都对着"库里没东西"发红。
  const parsed = parseResumeText(CORPUS_MD, DOC_ID, AS_OF_MS);
  if (parsed.status !== 'ok') throw new Error(`语料解析失败：${parsed.status}`);
  app['resume.doc'].save(parsed.document);
  app['kb.profile'].sync(DOC_ID, AS_OF_MS);
  return { app, db: app.store.db };
}

/**
 * 读工作副本落在库里的那一字节（用于"逐字未变"的比对，判据三）。
 * @param db 真 sqlite 连接
 * @returns `resume_docs` 里那份文档的 `updated_at` 与正文串；查无返回 null
 */
function workingCopy(db: DatabaseSync): { updatedAt: number; body: string } {
  const row = db.prepare('SELECT updated_at, doc_json AS body FROM resume_docs WHERE id = ?').get(DOC_ID) as
    { updated_at?: number | bigint; body?: string } | undefined;
  if (row === undefined) throw new Error(`工作副本 ${DOC_ID} 没落进 resume_docs：装配或建表出了问题`);
  return { updatedAt: Number(row.updated_at ?? -1), body: String(row.body ?? '') };
}

/**
 * 数生成记录表的行数（表不存在时 sqlite 直接抛 `no such table`，那正是号段撞车要显出来的样子）。
 * @param db 真 sqlite 连接
 * @returns `resume_generations` 的行数
 */
function generationRowCount(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM resume_generations').get() as { n?: number | bigint };
  return Number(row.n ?? 0);
}

/**
 * 按字节读出库里那份工作副本并解析（接受面判"落盘的到底是哪一份"，判据三的反面）。
 * @param db 真 sqlite 连接
 * @returns `save()` 规范化之后落库的那份文档对象
 */
function storedDoc(db: DatabaseSync): Record<string, unknown> {
  const row = db.prepare('SELECT doc_json AS body FROM resume_docs WHERE id = ?').get(DOC_ID) as
    { body?: string } | undefined;
  if (row?.body === undefined) throw new Error(`工作副本 ${DOC_ID} 没落进 resume_docs：装配或建表出了问题`);
  return JSON.parse(row.body) as Record<string, unknown>;
}

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
  // 日志写流是异步开文件的（同 `gap-quota-link.test.ts`）：不等一下就删目录会冒出收尾后的 ENOENT。
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 句柄延迟释放，清理失败不该把一次通过的验收判成失败。
    }
  }
});

describe('4.5-b 生成轨的真装配（号段 15 / 双入口 / 不写工作副本 / 镜像不漂移）', () => {
  it('号段 15 与 7 / 11～14 一起装得起来，一次生成落一行可复盘的记录（4.5-10）', async () => {
    const { app, db } = await bootAssembly();
    expect(generationRowCount(db)).toBe(0);
    const view = await app['resume.generate'].run(JD_TEXT, { docId: DOC_ID, jdId: 'jd-link-1' }, AS_OF_MS);
    expect(generationRowCount(db)).toBe(1);
    const row = db
      .prepare(
        'SELECT doc_id, jd_id, prompt_version, model, model_status, status, retried, evidence_json FROM resume_generations',
      )
      .get() as Record<string, unknown>;
    expect(row.doc_id).toBe(DOC_ID);
    expect(row.jd_id).toBe('jd-link-1');
    // 没问过模型就不许报提示词版本与模型名（4.5-10 的复盘要能分清"哪一版产的"与"根本没产"）。
    expect(row.prompt_version).toBeNull();
    expect(row.model).toBeNull();
    expect(row.model_status).toBe('unavailable');
    expect(row.status).toBe('reorder_only');
    expect(Number(row.retried)).toBe(0);
    // 4.5-06 的反查面在真库里留得住：证据 id 落进 `evidence_json`，正文不落（§8.5）。
    const evidenceIds = JSON.parse(String(row.evidence_json)) as Array<{ evidenceId: string }>;
    expect(evidenceIds.length).toBeGreaterThan(0);
    expect(view.evidence.length).toBe(evidenceIds.length);
  });

  it('agent 工具面经真注册表调得通，与直调 service 同一条链（4.5-01 的双入口 / §5.9）', async () => {
    const { app } = await bootAssembly();
    const tools = app['agent.tools'];
    expect(tools.list().map((tool) => tool.id)).toContain('resume.generate.run');
    const reply = await tools.call('resume.generate.run', { jdText: JD_TEXT, docId: DOC_ID });
    expect(reply.ok).toBe(true);
    if (!reply.ok) throw new Error(`工具调用失败：${reply.code} · ${reply.message}`);
    const viaTool = reply.result.value as GenerationView;
    expect(viaTool.receipt.outcome).toBe('reorder_only');
    expect(viaTool.checks.ok).toBe(true);
    // spec 5.1-11：摘要与证据引用是「读数」的一部分，真链路上就得带上——4.5-06 的反查面靠它，
    // 而不是让渲染层按工具 id 自己去拼一份第二事实（§2.5）。
    expect(reply.result.summary).not.toBe('');
    expect(reply.result.evidenceRefs.length).toBeGreaterThan(0);
    // 畸形入参在递给实现之前就被 schema 挡下（工具面的入站数据按不可信输入处理）。
    expect((await tools.call('resume.generate.run', { jdText: JD_TEXT, docId: '' })).ok).toBe(false);
  });

  it('跑完生成之后工作副本逐字未变：`run()` 一次 save 都不发生（plan §4.5 判据三）', async () => {
    const { app, db } = await bootAssembly();
    const before = workingCopy(db);
    const view = await app['resume.generate'].run(JD_TEXT, { docId: DOC_ID }, AS_OF_MS);
    expect(view.checks.ok).toBe(true);
    // 正向对照：这一次确实生成并落库了（否则"未变"可能只是因为什么都没跑）。
    expect(generationRowCount(db)).toBe(1);
    // 反向判定按字节读库里那一份：`updated_at` 与 `doc_json` 都停在导入时的样子，提议态只活在返回体里。
    // 这里比整串 `doc_json` 而不是比文档对象：`save()` 存的是文档自带的 `updatedAt`（它自己不重新打点），
    // 所以"时间戳没变"证明不了没被写过——真正留得住痕迹的是正文那一列。也正因如此，`accept()`
    // 必须在写入时自己盖章（见 `generate-service.ts` 里那句注释），否则改过简历却读不出先后。
    expect(workingCopy(db)).toEqual(before);
  });

  it('过界的那一份与 `shared` 的镜像同形，且结构化克隆得过去（4.5-11 的数据面）', async () => {
    const { app } = await bootAssembly();
    const view = await app['resume.generate'].run(JD_TEXT, { docId: DOC_ID }, AS_OF_MS);
    // 编译期保险丝：服务侧任何一侧改了形状而 `shared` 没跟上，这一行就红。
    const preview: GenerationRunRowView = {
      rewrites: view.rewrites,
      evidence: view.evidence,
      reorderBases: view.reorderBases,
      checks: view.checks,
      receipt: view.receipt,
    };
    const cloned = structuredClone(preview);
    expect(cloned.receipt.outcome).toBe('reorder_only');
    // 保守版的播报半边（4.5-09）：没有改写、但产物合法且降级写在了 `modelStatus` 上。
    expect(cloned.rewrites).toEqual([]);
    expect(cloned.receipt.modelStatus).toBe('unavailable');
    expect(cloned.receipt.modelReason).not.toBeNull();
  });
});

describe('4.5-c 接受面的真装配（唯一写工作副本的一口，spec 4.5-11 的接线半边）', () => {
  it('只采纳重排也在真库里写回：落盘的就是产物那一份，`updated_at` 等于表态时刻（判据三的反面）', async () => {
    const { app, db } = await bootAssembly();
    const view = await app['resume.generate'].run(JD_TEXT, { docId: DOC_ID }, AS_OF_MS);
    const product = view.document;
    if (product === null) throw new Error('保守版应当有产物：装配或降级路径出了问题');
    const moved = view.receipt.movedSections + view.receipt.movedEntries;
    expect(moved).toBeGreaterThan(0);
    const before = workingCopy(db);
    const acceptAt = AS_OF_MS + 60_000;
    const result = app['resume.generate'].accept(
      view.receipt.id,
      { acceptedIndexes: [], applyReorder: true },
      acceptAt,
    );
    expect(result).toEqual({
      docId: DOC_ID,
      receiptId: view.receipt.id,
      appliedRewrites: 0,
      reorderApplied: true,
      movedSections: view.receipt.movedSections,
      movedEntries: view.receipt.movedEntries,
      updatedAt: acceptAt,
    });
    expect(workingCopy(db).updatedAt).toBe(acceptAt);
    expect(workingCopy(db).body).not.toBe(before.body);
    // 落盘内容与主进程那份产物同源：顺序真的换了，而一条改写都没勾，正文字字未动。
    expect(storedDoc(db).sections).toEqual(product.sections);
    // 接受口不许成为唯一能把简历存坏的通道——写进去的那一份读回来仍是合法文档（3.1-08 的安全往返）。
    expect(app['resume.doc'].load(DOC_ID).status).toBe('found');
    // 编译期保险丝 + 结构化克隆：界面按下的那个按钮拿到的形状与 `shared` 镜像同步（4.5-11 的数据面）。
    const row: GenerationAcceptRowResult = result;
    expect(structuredClone(row).receiptId).toBe(view.receipt.id);
  });

  it('一条没勾、重排也没采纳时一次盘都不落，且那份提议态没被用掉（"不写"必须是真的不写）', async () => {
    const { app, db } = await bootAssembly();
    const view = await app['resume.generate'].run(JD_TEXT, { docId: DOC_ID }, AS_OF_MS);
    const before = workingCopy(db);
    const empty = app['resume.generate'].accept(
      view.receipt.id,
      { acceptedIndexes: [], applyReorder: false },
      AS_OF_MS + 1000,
    );
    expect(empty).toMatchObject({ appliedRewrites: 0, reorderApplied: false, movedSections: 0, movedEntries: 0 });
    // 播报的是库里那一版当下的时刻，不是这次点按钮的时刻：什么都没改，界面就不该显示"刚刚被改过"。
    expect(empty.updatedAt).toBe(before.updatedAt);
    expect(workingCopy(db)).toEqual(before);
    // 没写东西就不算用掉：同一份产物随后采纳重排仍然可用，不必重新生成一次。
    const retryAt = AS_OF_MS + 2000;
    expect(
      app['resume.generate'].accept(view.receipt.id, { acceptedIndexes: [], applyReorder: true }, retryAt).updatedAt,
    ).toBe(retryAt);
  });

  it('用户在生成之后自己存过简历：接受被基线挡下，库里留的仍是用户那一版', async () => {
    const { app, db } = await bootAssembly();
    const view = await app['resume.generate'].run(JD_TEXT, { docId: DOC_ID }, AS_OF_MS);
    const loaded = app['resume.doc'].load(DOC_ID);
    if (loaded.status !== 'found') throw new Error(`读不回工作副本：${loaded.status}`);
    // 用户侧每一次保存都会带新的 `updatedAt`（3.1 的界面保存路径），所以只动这一位就足以代表"生成后改过"。
    const userEditedAt = AS_OF_MS + 30_000;
    app['resume.doc'].save({ ...loaded.document, updatedAt: userEditedAt });
    const userCopy = workingCopy(db);
    let caught: unknown;
    try {
      app['resume.generate'].accept(view.receipt.id, { acceptedIndexes: [], applyReorder: true }, userEditedAt + 1000);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('KB_GENERATION_STALE_BASELINE');
    // 挡下来必须是不写：两份改动叠在一起是谁都没法解释的产物，用户那一版得逐字留在库里。
    expect(workingCopy(db)).toEqual(userCopy);
  });

  it('写口只对界面开放：白名单放行 accept，agent 只拿到 run，文档正文从不过界（4.5-11 / 判据二）', async () => {
    const { app } = await bootAssembly();
    expect(isAllowedCall('resume.generate.run')).toBe(true);
    expect(isAllowedCall('resume.generate.accept')).toBe(true);
    // 界面没有 `resume.doc.*` 任何一条口，所以"改前正文"只能随改写行一起过界（`bridge.ts` 本节头注释 ③）。
    expect(isAllowedCall('resume.doc.save')).toBe(false);
    expect(isAllowedCall('resume.doc.load')).toBe(false);
    // 反向验证（§6.5）：接受不是 agent 工具——让模型替用户在简历上签字，等于把 4.5-11 的人工确认绕掉。
    expect(
      app['agent.tools']
        .list()
        .map((tool) => tool.id)
        .filter((id) => id.startsWith('resume.generate')),
    ).toEqual(['resume.generate.run']);
  });
});
