/**
 * `kb.skill` 的装配面用例（spec 4.9-01 / 4.9-02 / 4.9-03 / 4.9-04 / 4.9-08）。
 *
 * 判据重心在三件事：① 生效正文永远是"覆盖 ?? 内置"这一份（不允许出现第三份事实，§2.7）；
 * ② 一键还原回到内置是**逐字节**相同，不是"再拼一次大概一样"；
 * ③ "不能删除"是结构性的——桥面只开了四句，第五句（删除）根本不存在，
 *    因此不需要一条"删除被拒绝"的用例，而需要一条"删除口不存在"的用例。
 */
import { asApp, Context, type Fiber } from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { createEmptyDocument, ResumeDocService } from '@auto-cc/plugin-resume-doc';
import { StoreService } from '@auto-cc/plugin-store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BUILTIN_RESUME_SKILL_BODY, REQUIRED_INFO } from './skill.js';
import { KbSkillService, RESUME_SKILL_MIGRATION_VERSION } from './skill-service.js';

const sandboxes: string[] = [];
const fibers: Fiber[] = [];

/** 挂一套隔离的 config + store + resume.doc + kb.skill（技能服务只 inject 这三样，不需要模型）。 */
async function boot(maxContentChars = 20000) {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-skill-'));
  sandboxes.push(dir);
  const ctx = new Context();
  fibers.push(await ctx.plugin(ConfigService, { appName: 'auto-cc', paths: { userDataDir: dir } }));
  fibers.push(await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' }));
  fibers.push(await ctx.plugin(ResumeDocService, {}));
  fibers.push(await ctx.plugin(KbSkillService, { maxContentChars }));
  const app = asApp(ctx);
  return { skill: app['kb.skill'], docs: app['resume.doc'], db: app.store.db };
}

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

describe('4.9-01 / 4.9-03 生效来源与一键还原', () => {
  it('从没改过时读到的就是内置正文，来源 builtin、改动时刻 null', async () => {
    const { skill } = await boot();
    const view = skill.read();
    expect(view.source).toBe('builtin');
    expect(view.content).toBe(BUILTIN_RESUME_SKILL_BODY);
    expect(view.updatedAt).toBeNull();
    expect(view.chars).toBe(BUILTIN_RESUME_SKILL_BODY.length);
    expect(view.maxChars).toBe(20000);
    expect(skill.contentForGeneration()).toBe(BUILTIN_RESUME_SKILL_BODY);
  });

  it('改一处就变 custom，还原后与内置逐字节相同（不是"再拼一次大概一样"）', async () => {
    const { skill } = await boot();
    const edited = `${BUILTIN_RESUME_SKILL_BODY}\n\n自定义：把成果写在每段的第一句。`;
    const saved = skill.save(edited);
    expect(saved.source).toBe('custom');
    expect(saved.content).toBe(edited);
    expect(typeof saved.updatedAt).toBe('number');

    const restored = skill.reset();
    expect(restored.source).toBe('builtin');
    expect(restored.content).toBe(BUILTIN_RESUME_SKILL_BODY);
    expect(restored.content).toBe(skill.read().content);
    expect(restored.updatedAt).toBeNull();
  });

  it('迁移 38 落台账且重复挂载不重复推号（同 5.3-a：改老迁移的 up 不会重跑）', async () => {
    const { db } = await boot();
    const versions = db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((row) => Number(row.version));
    expect(versions).toContain(RESUME_SKILL_MIGRATION_VERSION);
    expect(versions.filter((version) => version === RESUME_SKILL_MIGRATION_VERSION)).toHaveLength(1);
  });
});

describe('4.9-02 保存面的两条拒绝', () => {
  it('空正文被拒：它是"改了但等于没改"这一类界面说谎的源头', async () => {
    const { skill } = await boot();
    expect(() => skill.save('   \n  ')).toThrowError(/不能是空的/u);
    expect(skill.read().source).toBe('builtin');
  });

  it('超上限被拒，上限来自配置而不是写死在渲染层', async () => {
    const { skill } = await boot(300);
    expect(() => skill.save('指'.repeat(301))).toThrowError(/超过上限/u);
    expect(skill.save('指'.repeat(300)).chars).toBe(300);
  });
});

describe('4.9-04 不可删是结构性的：服务面只有四句', () => {
  // 白名单那半边（`kb.skill.*` 只有四句、没有第五句删除口）住在 `packages/main/src/generate-link.test.ts`：
  // `@auto-cc/shared` 不在本包的依赖清单里，在这里 import 它会以"找不到包"收场，而不是以判据收场。
  it('服务面上也没有任何删除入口：内置正文不在库里，因此压根删不掉', () => {
    const methods = Object.getOwnPropertyNames(KbSkillService.prototype).filter((name) => name !== 'constructor');
    expect(methods.some((name) => /delete|remove|clear/i.test(name))).toBe(false);
  });
});

describe('4.9-08 必备信息判定走的是工作副本那一份', () => {
  it('副本不存在时报 KB_SOURCE_MISSING，而不是回一份空清单', async () => {
    const { skill } = await boot();
    expect(() => skill.checkDocument('no-such-doc')).toThrowError(/不存在/u);
  });

  it('存进去一份缺项的简历，读回来的缺项与表同源（12 行、缺的那几行是 missing）', async () => {
    const { skill, docs } = await boot();
    // 空文档走模型层的出厂构造（`resume.doc` 没有 create 口，正文唯一入口就是 `save`）。
    docs.save(createEmptyDocument('resume-for-skill', Date.now()));
    const rows = skill.checkDocument('resume-for-skill');
    expect(rows).toHaveLength(REQUIRED_INFO.length);
    expect(rows.filter((row) => row.status === 'missing').map((row) => row.id)).toContain('name');
  });
});
