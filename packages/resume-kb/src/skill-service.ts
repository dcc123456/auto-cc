/**
 * `kb.skill` service（spec 4.9-01 ～ 4.9-04 / 4.9-09，plan §4.9 裁定 A2 / A3 / A5）。
 *
 * 本服务只干三件事：把**内置正文**与**人的覆盖**合成一份生效指引、把人的覆盖存住、
 * 以及按一份文档给出必备信息的逐项读数。判定本体在 `skill.ts`（纯函数），这里只有装配与读写。
 *
 * "可以改、不能删、可一键还原"是**结构性**的，不是界面上少画一颗键：
 * - 内置正文随代码发货，**库里没有它**，所以没有任何一次调用能把它删掉；
 * - 表 `resume_skill_override` 里那一行存的是**覆盖**，`reset()` 删的是覆盖行，删完自然回到内置；
 * - 本服务对外只有 `read / save / reset / checkDocument` 四张口，桥接白名单里也不会有第五张（4.9-04 的机检）。
 *
 * 为什么另起一张表而不是塞进 `resume_preferences`（迁移 36）：那张表 own 的是**界面偏好键**
 * （目前只有 `defaultTemplateId`），而一份可能被改上千字、还要记"人改过没有 / 改于何时"的内容文档
 * 塞进去，等于让偏好表长出一列正文与一套覆盖语义（plan §4.9 取证二第 2 条的否决理由）。
 */
import { AppError, asApp, Service, type Context } from '@auto-cc/core';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { ResumeDocument } from '@auto-cc/plugin-resume-doc';
import {
  BUILTIN_RESUME_SKILL_BODY,
  checkRequiredInfo,
  RESUME_SKILL_ID,
  RESUME_SKILL_VERSION,
  type RequiredInfoRow,
} from './skill.js';

/**
 * 迁移号段：**38**（AGENTS.md §9 的 5.3-a 号段台账）。
 * 36 是 `resume_preferences`、37 是 `resume_imports` 的同名来源列，两通道 grep 过 38 零命中；
 * 与 §9 的口径一致——不回填 34 那种"读不到但可能被占"的号，往后取。
 */
export const RESUME_SKILL_MIGRATION_VERSION = 38;

/** 覆盖表：一行一支技能，主键就是内置技能的 id。 */
const resumeSkillOverrideMigration = {
  version: RESUME_SKILL_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    db.exec(`CREATE TABLE IF NOT EXISTS resume_skill_override (
      skill_id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
  },
  down: (db: DatabaseSync) => {
    db.exec('DROP TABLE IF EXISTS resume_skill_override');
  },
};

/** 生效来源两态：库里没有覆盖行就是 `builtin`（界面据此决定"还原"这颗键按不按得动）。 */
export const KB_SKILL_SOURCES = ['builtin', 'custom'] as const;

/** 生效来源的字面量类型。 */
export type KbSkillSource = (typeof KB_SKILL_SOURCES)[number];

/** 界面上的那一份读数（过 IPC，不含正文之外的东西；`builtinContent` 让"你改过"这句话有据可依）。 */
export interface KbSkillReadView {
  skillId: string;
  version: string;
  source: KbSkillSource;
  /** 生效正文：有覆盖就是人改过的那一份，否则是内置那一份。 */
  content: string;
  /** 内置原文（对照用；还原时回到它，逐字节）。 */
  builtinContent: string;
  /** 生效正文字数（界面标题行显示，不用在渲染层再算一遍）。 */
  chars: number;
  /** 覆盖行的改动时刻（毫秒）；未改过时为 null。 */
  updatedAt: number | null;
  /** 保存时的长度上限（配置值，界面据此设 `maxLength`，避免出现第二处上限）。 */
  maxChars: number;
}

/**
 * `kb.skill` 的可调项（代码内不留魔法数，同 4.4 / 4.5 的口径）。
 */
export const kbSkillSchema = z.strictObject({
  /**
   * 生效正文的长度上限（字符）。
   * 取 20 000 的理由：内置正文约 1 200 字，人要往里粘一份自己的模板也够，
   * 再长就要开始占提示词预算——注入那一格的上界由 `prompts.ts` 的截断负责，这里只挡写入面。
   */
  maxContentChars: z.number().int().min(200).max(100000).default(20000),
});

/** 配置形状（取 Schema 的输出，AGENTS.md §9 的 1.3 实测）。 */
export type KbSkillConfig = z.infer<typeof kbSkillSchema>;

/** 覆盖表一行。 */
type OverrideRow = { content: string | null; updated_at: number | bigint | null };

/**
 * 技能服务。
 *
 * `resume.doc` 写成 `inject`：`checkDocument` 的判据就是"对一份真实工作副本逐项判定"，
 * 没有文档这一格功能不成立，缺席时让它挂载即失败比调用时才报"功能不可用"更诚实
 * （与 `resume.generate` 刻意**不**注入 `kb.gap` 的情况不同：那条缺席还有纯本地路径可退）。
 */
export class KbSkillService extends Service {
  static provide = 'kb.skill';
  static Config = kbSkillSchema;
  static inject = ['store', 'resume.doc'];

  constructor(
    ctx: Context,
    private readonly options: KbSkillConfig,
  ) {
    super(ctx, 'kb.skill');
  }

  private get store() {
    return asApp(this.ctx).store;
  }

  /** 幂等地把迁移 38 推进共享迁移列表并升级到最新（同 5.3-a：改老迁移的 `up` 不会重跑）。 */
  private ensureSchema(): void {
    const { migrations } = this.store;
    if (!migrations.some((item) => item.version === RESUME_SKILL_MIGRATION_VERSION)) {
      migrations.push(resumeSkillOverrideMigration);
    }
    this.store.upgrade();
  }

  /**
   * 挂载时建表并播报生效来源（界面与日志都要能看出"这一轮用的是内置还是改过的"）。
   * @returns 无返回值
   */
  [Service.init](): void {
    this.ensureSchema();
    const view = this.read();
    this.ctx.logger.info(
      `[kb-skill] 书写技能就绪，迁移号段 ${String(RESUME_SKILL_MIGRATION_VERSION)} · ` +
        `版本 ${view.version} · 来源 ${view.source} · ${String(view.chars)} 字`,
    );
  }

  /**
   * 读生效技能（4.9-01 / 4.9-03 的那一口）。
   * @returns 含生效正文、内置原文、来源与改动时刻的读数
   */
  read(): KbSkillReadView {
    const row = this.store.db
      .prepare('SELECT content, updated_at FROM resume_skill_override WHERE skill_id = ?')
      .get(RESUME_SKILL_ID) as OverrideRow | undefined;
    const override = row?.content ?? null;
    const content = override ?? BUILTIN_RESUME_SKILL_BODY;
    return {
      skillId: RESUME_SKILL_ID,
      version: RESUME_SKILL_VERSION,
      source: override === null ? 'builtin' : 'custom',
      content,
      builtinContent: BUILTIN_RESUME_SKILL_BODY,
      chars: content.length,
      updatedAt: override === null ? null : Number(row?.updated_at),
      maxChars: this.options.maxContentChars,
    };
  }

  /**
   * 存下人改过的那一份（4.9-02）。
   *
   * 空正文与超长正文都在写之前拒绝：前者会让生成轨拿到一份"没有依据"的指引而界面上仍然显示已保存，
   * 后者会把提示词那一格撑爆（截断在 `prompts.ts`，但写入面不该等着被截）。
   * @param content 改后的整份正文（逐字存，不做规范化——人改的就是人写的）
   * @returns 保存后的生效读数
   * @throws AppError(`INVALID_ARGUMENT`) 空正文或超过 `maxContentChars`
   */
  save(content: string): KbSkillReadView {
    if (content.trim() === '') {
      throw new AppError('INVALID_ARGUMENT', '技能正文不能是空的：要回到出厂写法请点「还原为内置」');
    }
    if (content.length > this.options.maxContentChars) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `技能正文 ${String(content.length)} 字，超过上限 ${String(this.options.maxContentChars)}：` +
          `删掉不需要的段落再保存（上限可在配置里改）`,
      );
    }
    this.store.db
      .prepare(
        `INSERT INTO resume_skill_override (skill_id, content, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(skill_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
      )
      .run(RESUME_SKILL_ID, content, Date.now());
    return this.read();
  }

  /**
   * 一键还原（4.9-03）：删掉的只是**覆盖行**，内置正文不在库里，因此删不掉。
   *
   * 返回的是还原后的生效读数，调用方据此立刻重画界面——不在渲染层留第二份正文（§2.7）。
   * @returns 与内置正文逐字节相同的生效读数，`source` 回到 `builtin`
   */
  reset(): KbSkillReadView {
    this.store.db.prepare('DELETE FROM resume_skill_override WHERE skill_id = ?').run(RESUME_SKILL_ID);
    return this.read();
  }

  /**
   * 生效正文（生成轨用这一口，不构造整份读数对象：它只需要字，不需要界面用的那些计数）。
   * @returns 覆盖 ?? 内置 的那一份正文
   */
  contentForGeneration(): string {
    return this.read().content;
  }

  /**
   * 对一份工作副本逐项判定必备信息（4.9-09 的入口，也是 4.9-07 / 4.9-08 的取证口）。
   *
   * 只给判定与档位、不给正文：正文留在文档侧，界面要的是"哪一项缺"。
   * @param docId 要核对的那份简历
   * @returns 与 `REQUIRED_INFO` 同序的逐项读数
   * @throws AppError(`KB_SOURCE_MISSING`) 副本不存在或已损坏
   */
  checkDocument(docId: string): RequiredInfoRow[] {
    const loaded = asApp(this.ctx)['resume.doc'].load(docId);
    if (loaded.status !== 'found') {
      throw new AppError('KB_SOURCE_MISSING', `工作副本 ${docId} ${loaded.status === 'missing' ? '不存在' : '已损坏'}：先导入一份简历再核对必备信息`);
    }
    return this.checkDocumentObject(loaded.document);
  }

  /**
   * 直接对内存里那份文档判定（生成轨用它算"改写前 / 改写后"两份读数，不再走一次库）。
   * @param document 简历文档
   * @returns 逐项读数
   */
  checkDocumentObject(document: ResumeDocument): RequiredInfoRow[] {
    return checkRequiredInfo(document);
  }
}
