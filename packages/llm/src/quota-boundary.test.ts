/**
 * 额度接线边界（spec 4.4-09 的模型腿半边，判据见 `docs/plans/04-resume-kb/plan.md` §4.4-e 判据一）。
 *
 * 为什么这条断言住在本包而不是 `packages/main`：4.4-09 要判的是「**本地调用不误扣额度**」，
 * 而模型腿的调用方有 `outbound.script`、`kb.gap`、将来的 P5 规划好几处——在装配层逐个调用方测，
 * 每加一个调用方就得加一条用例，且永远漏掉下一个。本包是全仓唯一的模型出口
 * （`scripts/check-llm-single-entry.ts` 已在机检这件事），所以「出口本身不碰账本」是一条
 * **射程覆盖全部调用方**的断言：只要这条绿，任何调用方的模型腿都不可能落账。
 *
 * 判据一同时预先定死了将来真要计费时的落点：新增 `llm` 动作键、在**本包**的 `complete/embed`
 * 里经 `gate.perform` 落账。因此这里的断言写成「本包源码里不存在闸门/账本的引用」——
 * 一旦按那个设计接线，这条用例会红，届时**必须**连同 spec 条目一起改，而不是顺手豁免掉，
 * 这样"额度行为发生变化"这件事就不可能悄悄发生（AGENTS.md §2.6：边界校验只在系统边界做）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 账本与闸门的**全部**可辨识入口（按能力搜，不只按名字：判定、放行、落账、计数）。
 *
 * 只写 `entitlement.gate` 是不够的——绕过闸门最自然的方式是直接写 `usage_ledger` 那张表，
 * 所以 SQL 表名、service 名、动作枚举、以及落账/计数的方法名都要在扫描面里。
 */
const QUOTA_SURFACES: readonly (readonly [RegExp, string])[] = [
  [/entitlement\.gate/, '闸门 service 名'],
  [/usage\.ledger/, '账本 service 名'],
  [/EntitlementGateService|UsageLedgerService/, '闸门/账本的类名'],
  [/@auto-cc\/plugin-entitlement/, '额度包的 import 路径'],
  [/usage_ledger/, '账本表名（绕过闸门直接写表）'],
  [/QUOTA_ACTIONS/, '额度动作枚举'],
  [/\bperform\s*\(\s*['"]/, '闸门的一次性「判定+执行+落账」调用'],
  [/\bcountToday\b|\blatestActionTs\b/, '账本的读数方法'],
];

/**
 * 列出本包的非测试源码文件。
 *
 * 测试文件不参与扫描：本包与 `packages/main` 的用例里会出现「额度」字样（正是用来证明不扣的），
 * 把它们算进射程就等于让断言永远只能靠豁免通过。同 `check-compliance-redlines.ts` 的 `isTestFile` 口径。
 * @returns 源码文件绝对路径列表
 */
function sourceFiles(): string[] {
  return readdirSync(import.meta.dirname)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.endsWith('.spec.ts'))
    .map((file) => join(import.meta.dirname, file));
}

describe('模型出口不接额度闸门（4.4-09：本地调用不误扣额度）', () => {
  it('本包源码里没有闸门/账本的任何入口，也没有直接写 usage_ledger 的 SQL', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(file, 'utf8');
      for (const [pattern, label] of QUOTA_SURFACES) {
        if (pattern.test(text)) offenders.push(`${file.split(/[\\/]/).pop()} 命中 ${label}（${pattern}）`);
      }
    }
    expect(offenders).toEqual([]);
    // 扫描面不能是空的：文件名过滤器写错时上面那条会「因为没扫到文件」而永远通过。
    expect(sourceFiles().length).toBeGreaterThan(2);
  });

  it('依赖清单里没有额度包：本包在编译期就够不着账本（结构面比字符串面更硬）', () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const quotaDependencies = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter(
      (name) => name === '@auto-cc/plugin-entitlement',
    );
    expect(quotaDependencies).toEqual([]);
  });

  // 第三条「不计费也要回报用量」不在这里重复断言：`llm.test.ts` 已经按存根把
  // `promptTokens/completionTokens` 的读出与「对端不回报时为 null」都判过了（§2.5 一个功能一个入口）。
});
