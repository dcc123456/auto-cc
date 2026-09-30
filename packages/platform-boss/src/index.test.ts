import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadBossKnowledgePack } from './index.js';
import bundledBossPack from './knowledge/boss.json';

const sandboxes: string[] = [];

afterAll(() => {
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 上句柄延迟释放会留下残渣：清理失败不该把一次通过的验收判成失败。
    }
  }
});

/**
 * 读一次装载并取回结构化错误的码。
 * @param call 被检的装载调用（配置里的 `packFile` 指向什么文件）
 * @returns 抛出的 `AppError` 码；没抛时为 null（失败要能被断言，而不是让测试直接红）
 */
const caughtCode = (call: () => unknown): string | null => {
  try {
    call();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? null;
  }
};

/** 开一个系统临时目录并记账，用例结束后统一删除（AGENTS.md §7.5：测试产物不进 git）。 */
const makeSandbox = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'auto-cc-boss-pack-'));
  sandboxes.push(dir);
  return dir;
};

/** 把一份知识包写到仓库之外的临时目录里，返回文件路径。 */
const writePack = (name: string, content: unknown): string => {
  const file = path.join(makeSandbox(), name);
  writeFileSync(file, JSON.stringify(content), 'utf8');
  return file;
};

describe('站点知识包装载（spec 2.2-08）', () => {
  it('内嵌知识包能过 parseKnowledgePack 的结构与定位声明两层校验', () => {
    const pack = loadBossKnowledgePack();
    expect(pack.platform).toBe('boss');
    expect(pack.capabilities).toEqual(['search', 'detail', 'chat', 'sendResume', 'readReplies']);
    expect(Object.keys(pack.locators).length).toBeGreaterThanOrEqual(10);
    expect(pack.fieldOrder).toEqual(['title', 'company', 'salary', 'city', 'experience', 'education']);
  });

  it('每条定位声明都有 2 条以上候选，且首条是稳定性最高的 testId 或 id', () => {
    const pack = loadBossKnowledgePack();
    for (const [name, spec] of Object.entries(pack.locators)) {
      expect(spec.candidates.length, `${name} 的候选数`).toBeGreaterThanOrEqual(2);
      expect(['testId', 'id'], `首条候选策略（${name}）`).toContain(spec.candidates[0]?.strategy);
    }
  });

  it('知识包只指向本地仿站，且包内没有任何真实平台的痕迹（AGENTS.md §7.2 与 plan §9.6 的许可闸门）', () => {
    const pack = loadBossKnowledgePack();
    // URL 串不参与选择器判定，但这里断言的是「地址本身」，所以用 origin 比对而不是正则。
    expect(new URL(pack.startUrl).origin).toBe('http://127.0.0.1:10233');
    expect(JSON.stringify(pack)).not.toMatch(/zhipin|liepin|\.com\//i);
  });

  it('配置了 packFile 时用外部那份，站点改版只改数据不动 TS', () => {
    const overridden = { ...bundledBossPack, displayName: 'BOSS 直聘（外部知识包）' };
    const pack = loadBossKnowledgePack(writePack('boss.json', overridden));
    expect(pack.displayName).toBe('BOSS 直聘（外部知识包）');
    expect(pack.locators.jobTitle?.candidates[0]?.value).toBe('title');
    // 覆盖只作用于这一次装载：内嵌那份仍是随包发布的内容。
    expect(loadBossKnowledgePack().displayName).toBe('BOSS 直聘');
  });

  it('定位声明不合法时以 KNOWLEDGE_PACK_INVALID 失败，绝不返回半残的包', () => {
    const broken = {
      ...bundledBossPack,
      // testId 候选缺 attribute：结构过得了 zod，但 `validateSpec` 会拒（这是第二层校验的证据）。
      locators: {
        jobCard: { description: '职位卡片', cardinality: 'single', candidates: [{ strategy: 'testId', value: 'x' }] },
      },
    };
    expect(caughtCode(() => loadBossKnowledgePack(writePack('broken.json', broken)))).toBe('KNOWLEDGE_PACK_INVALID');
  });

  it('文件不是合法 JSON 时同样是结构化失败，不抛解析层的裸异常', () => {
    const file = path.join(makeSandbox(), 'broken.json');
    writeFileSync(file, '{ 这不是 JSON', 'utf8');
    expect(caughtCode(() => loadBossKnowledgePack(file))).toBe('KNOWLEDGE_PACK_INVALID');
  });
});
