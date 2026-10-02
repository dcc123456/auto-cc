/**
 * `kb.gap` 的装配用例（spec 4.4-01 的入参边界 / 4.4-06 的计数可见 / 4.4-08 的离线口径 / 4.3-12 的脱敏延续）。
 *
 * 拆解规则本身在 `requirements.test.ts` 里逐条断过了，这里只判服务这一层的四件事：
 * 入参校验、每类上限走配置、结果里的计数据实、日志只有计数没有 JD 正文。
 * 语料是**写在文件里的本地样例**（§7.2 不许碰真实招聘平台），公司名与手机号都是虚构。
 *
 * 4.4-08 的另一半（不联网）在这里是**结构性成立**而不是断言：本包的这条链只挂
 * `config` + `logger` + `kb.gap`，装配里根本没有 `store` 与 `llm.*`，
 * 而 `pnpm lint` 的零上行机检（`check-llm-single-entry.ts`）已经保证出网入口只在 `packages/llm`。
 */
import { AppError, Context, type Fiber } from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { LogService } from '@auto-cc/plugin-logger';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { KbGapService, type KbGapConfig } from './gap-service.js';
import { waitForLogLine } from './log-file.js';
import { REQUIREMENT_LEXICON_VERSION } from './requirements.js';

/** 固定样例 JD（虚构）：四类齐全，正文里埋一句可当哨兵的长句与一个假手机号。 */
const SAMPLE_JD = [
  '后端工程师（星桥科技）',
  '负责订单与推荐链路的后端服务，技术栈以 Java、Go、Kafka 为主，联系电话 13800002222。',
  '要求本科及以上学历，3 年以上相关工作经验，抗压能力强。',
].join('\n');

/** 装配用的默认配置（与 `cordis.yml` 的 `kb-gap` 段同源，改动要两边一起看）。 */
const DEFAULT_CONFIG: KbGapConfig = { perKindLimit: 12, minJdChars: 20 };

const tempDirs: string[] = [];
const fibers: Fiber[] = [];

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
  // 日志写流是异步开文件的（同 profile-service.test.ts），删目录前给一次宽限期。
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 句柄延迟释放，清理失败不该把一次通过的验收判成失败。
    }
  }
});

/**
 * 建一份只挂知识库拆解这一条链的装配。
 * @param config 覆盖项（不传就用 `DEFAULT_CONFIG`）——每类上限那条用例要靠它
 * @returns 服务实例、日志文件路径与临时目录（目录进 `tempDirs` 由 afterAll 清）
 */
async function bootGap(config: Partial<KbGapConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-kb-gap-'));
  tempDirs.push(dir);
  const ctx = new Context();
  fibers.push(await ctx.plugin(ConfigService, { appName: 'auto-cc' }));
  fibers.push(await ctx.plugin(LogService, { level: 'info', buffer: 50, file: 'auto-cc.log', dir, redact: false }));
  fibers.push(await ctx.plugin(KbGapService, { ...DEFAULT_CONFIG, ...config }));
  return { gap: ctx.get('kb.gap') as unknown as KbGapService, logFile: join(dir, 'auto-cc.log') };
}

describe('kb.gap 的拆解入口（spec 4.4-01 / 4.4-06）', () => {
  it('四类齐全，计数与词表版本随结果返回，且每条都是词面腿产的', async () => {
    const { gap } = await bootGap();
    const view = gap.extract(SAMPLE_JD);
    const kinds = new Set(view.items.map((item) => item.kind));
    expect([...kinds].sort()).toEqual(['education', 'experience_years', 'hard_skill', 'soft_skill'].sort());
    expect(view.items.every((item) => item.via === 'lexicon')).toBe(true);
    expect(view.lexiconVersion).toBe(REQUIREMENT_LEXICON_VERSION);
    expect(view.droppedByLimit).toBe(0);
    expect(view.items.length).toBeGreaterThan(0);
  });

  it('先去空白再判长度：输入两端留白不影响 inputChars 与产出（界面粘贴的常见形态）', async () => {
    const { gap } = await bootGap();
    const padded = gap.extract(`   \n${SAMPLE_JD}\n\n  `);
    const plain = gap.extract(SAMPLE_JD);
    expect(padded.inputChars).toBe(SAMPLE_JD.length);
    expect(padded.inputChars).toBe(plain.inputChars);
    expect(JSON.stringify(padded.items)).toBe(JSON.stringify(plain.items));
  });

  it('过短的 JD 结构化失败，而不是给一份空报告（spec 4.4-01 的入参校验）', async () => {
    const { gap } = await bootGap();
    let caught: unknown;
    try {
      gap.extract('后端工程师');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('INVALID_ARGUMENT');
    // 错误消息里带的必须是**字数**而不是 JD 正文（脱敏同样适用于错误路径）。
    expect((caught as AppError).message).toContain('字');
    expect((caught as AppError).message).not.toContain('后端工程师');
  });

  it('每类上限来自配置：调小之后只留稳定序列头部，丢弃条数如实报出', async () => {
    const { gap } = await bootGap({ perKindLimit: 1 });
    const capped = gap.extract(SAMPLE_JD);
    const full = (await bootGap()).gap.extract(SAMPLE_JD);
    const hard = capped.items.filter((item) => item.kind === 'hard_skill');
    expect(hard).toHaveLength(1);
    expect(hard[0]?.label).toBe(full.items.find((item) => item.kind === 'hard_skill')?.label);
    expect(capped.droppedByLimit).toBe(full.items.length - 4);
  });
});

describe('kb.gap 的日志脱敏（延续 spec 4.3-12 的口径）', () => {
  it('日志里只有四类计数与词表版本，查不到 JD 正文与手机号', async () => {
    const { gap, logFile } = await bootGap();
    gap.extract(SAMPLE_JD);
    const logText = await waitForLogLine(logFile, '[kb-gap] 词面拆解');
    expect(logText).toMatch(
      /\[kb-gap\] 词面拆解 \d+ 字 → 硬技能 \d+ \/ 软技能 \d+ \/ 学历 \d+ \/ 年限 \d+（丢弃 \d+，词表 lex-v\d）/,
    );
    for (const sentinel of ['负责订单与推荐链路的后端服务', '13800002222', '星桥科技', '抗压能力']) {
      expect(logText).not.toContain(sentinel);
    }
  });
});
