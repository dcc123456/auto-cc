import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadBossKnowledgePack } from './index.js';
import bundledFixturePack from './knowledge/boss-fixture.json';

/** 测试装配一律显式选仿站那份（AGENTS.md §7.2：自动化不许打到真实平台）。 */
const FIXTURE = { pack: 'fixture' as const };

/** 上线包（真 BOSS）与仿站包的选择常量，写成一份是为了让「谁在用哪份数据」在读数里看得见。 */
const REAL = { pack: 'real' as const };

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

describe('上线知识包装载（真 BOSS，spec 8.1-01 / 8.1-02 / 8.1-07）', () => {
  it('内嵌上线包能过两层校验，且它指向的是登记在册的真实源', () => {
    const pack = loadBossKnowledgePack(REAL);
    expect(pack.platform).toBe('boss');
    expect(pack.packStatus).toBe('shipped');
    expect(new URL(pack.startUrl).origin).toBe('https://www.zhipin.com');
    // 导航许可的唯一来源就是这一行（8.1-05）：名单里必须含起始页自己的源，否则第一个导航动作被自己的包拒掉。
    expect(pack.origins).toEqual(['https://www.zhipin.com']);
    expect(pack.origins).toContain(new URL(pack.startUrl).origin);
  });

  it('上线包的每条候选要么带在场取证凭据、要么显式 unverified（没有第三种写法）', () => {
    const pack = loadBossKnowledgePack(REAL);
    for (const [name, spec] of Object.entries(pack.locators)) {
      spec.candidates.forEach((candidate, index) => {
        const label = `${name} 候选 ${String(index)}（${candidate.strategy}）`;
        // 收成布尔再断言：直接 `toBe(true)` 会拿 evidence 那个对象去比 true，永远对不上。
        const hasEvidenceOrMarked = Boolean(candidate.evidence) || candidate.unverified === true;
        expect(hasEvidenceOrMarked, `${label}：既无 evidence 也未标 unverified`).toBe(true);
        // 证据必须能查到出处：只写 `{}` 的 evidence 等于没写。
        if (candidate.evidence) expect(candidate.evidence.ref).toMatch(/^docs\/acceptance\//);
      });
    }
  });

  it('【未实测】这类注释文案已经不在上线包里（8.1-03：没测通从一句话变成 unverified 这个机器字段）', () => {
    expect(JSON.stringify(bundledFixturePack)).not.toContain('未实测');
    const raw = JSON.stringify(loadBossKnowledgePack(REAL));
    expect(raw).not.toContain('未实测');
  });

  it('上线包不声明 sendResume：投递页的 offlinePattern 没有在场证据，宁可让这一格停在能力缺席上', () => {
    // 证据 8.0-06 第四节：`offlinePattern` 本次未取到（现场没有离线态样本），而第四节的 `riskPattern`
    // 是**故意不采集**（主动撞风控就是对 §8.3 红线的对抗）。缺的是页面知识，不是代码——
    // 所以这里删掉的是能力声明，不是猜一句「岗位已下架」填进上线包。补录了就把这一格加回来。
    const pack = loadBossKnowledgePack(REAL);
    expect(pack.capabilities).toEqual(['search', 'detail', 'chat', 'readReplies']);
    expect(pack.deliver).toBeUndefined();
    expect(pack.risk).toBeUndefined();
  });

  it('上线包把「只有 class 可选」的抓取定位登记成 effect:"read"，外发那两只没有', () => {
    // 裁定⑤ 的两半都在数据里：抓取容器降档（真 BOSS 全页无 testid，css 35 分恒 fail-closed，
    // 证据 8.0-03 第六节 A 条），而输入框/发送键留在严的那一档。
    const pack = loadBossKnowledgePack(REAL);
    expect(pack.locators.jobCard!.effect).toBe('read');
    expect(pack.locators.chatInput!.effect).toBeUndefined();
    expect(pack.locators.chatSendButton!.effect).toBeUndefined();
  });

  it('上线包的方向判据是 class token（真站点没有方向属性，证据 8.0-05 第四节）', () => {
    const pack = loadBossKnowledgePack(REAL);
    expect(pack.chat).toMatchObject({
      // 会话页不按 URL 参数切对象：`targetParam` 缺席是实测结论，不是漏写。
      entryPath: '/web/geek/chat',
      messageIdAttribute: 'data-mid',
      inboundClassToken: 'item-friend',
    });
    expect(pack.chat?.targetParam).toBeUndefined();
    expect(pack.chat?.directionAttribute).toBeUndefined();
  });
});

describe('仿站知识包装载（loopback 验收面，spec 8.1-07 保住原 G4 的意图）', () => {
  it('内嵌仿站包能过 parseKnowledgePack 的结构与定位声明两层校验', () => {
    const pack = loadBossKnowledgePack(FIXTURE);
    expect(pack.platform).toBe('boss');
    expect(pack.packStatus).toBe('draft');
    expect(pack.capabilities).toEqual(['search', 'detail', 'chat', 'sendResume', 'readReplies']);
    expect(Object.keys(pack.locators).length).toBeGreaterThanOrEqual(10);
    expect(pack.fieldOrder).toEqual(['title', 'company', 'salary', 'city', 'experience', 'education']);
  });

  it('仿站包里每条定位都有 2 条以上候选，且首条是稳定性最高的 testId 或 id', () => {
    const pack = loadBossKnowledgePack(FIXTURE);
    for (const [name, spec] of Object.entries(pack.locators)) {
      expect(spec.candidates.length, `${name} 的候选数`).toBeGreaterThanOrEqual(2);
      expect(['testId', 'id'], `首条候选策略（${name}）`).toContain(spec.candidates[0]?.strategy);
    }
  });

  it('仿站包只指向本地仿站，且仿站这份数据里没有任何真实平台的痕迹（AGENTS.md §7.2 与 plan §9.6 的许可闸门）', () => {
    const pack = loadBossKnowledgePack(FIXTURE);
    // URL 串不参与选择器判定，但这里断言的是「地址本身」，所以用 origin 比对而不是正则。
    expect(new URL(pack.startUrl).origin).toBe('http://127.0.0.1:10233');
    // 许可名单同样锁死在 loopback：仿站包哪怕被人改了 startUrl，也不该把真源带进测试装配。
    expect(pack.origins).toEqual(['http://127.0.0.1:10233']);
    expect(JSON.stringify(pack)).not.toMatch(/zhipin|liepin|\.com\//i);
  });

  it('默认用的是上线那份，不是仿站那份（打仿站必须写出来）', () => {
    expect(loadBossKnowledgePack().startUrl).toBe('https://www.zhipin.com/');
    expect(loadBossKnowledgePack({}).displayName).toBe('BOSS 直聘');
  });

  it('配置了 packFile 时用外部那份，站点改版只改数据不动 TS', () => {
    const overridden = { ...bundledFixturePack, displayName: 'BOSS 直聘（外部知识包）' };
    const pack = loadBossKnowledgePack({ packFile: writePack('boss.json', overridden) });
    expect(pack.displayName).toBe('BOSS 直聘（外部知识包）');
    expect(pack.locators.jobTitle?.candidates[0]?.value).toBe('title');
    // 覆盖只作用于这一次装载：内嵌那份仍是随包发布的内容。
    expect(loadBossKnowledgePack(FIXTURE).displayName).toBe('BOSS 直聘（本地仿站）');
  });

  it('定位声明不合法时以 KNOWLEDGE_PACK_INVALID 失败，绝不返回半残的包', () => {
    const broken = {
      ...bundledFixturePack,
      // testId 候选缺 attribute：结构过得了 zod，但 `validateSpec` 会拒（这是第二层校验的证据）。
      locators: {
        jobCard: { description: '职位卡片', cardinality: 'single', candidates: [{ strategy: 'testId', value: 'x' }] },
      },
    };
    expect(caughtCode(() => loadBossKnowledgePack({ packFile: writePack('broken.json', broken) }))).toBe(
      'KNOWLEDGE_PACK_INVALID',
    );
  });

  it('文件不是合法 JSON 时同样是结构化失败，不抛解析层的裸异常', () => {
    const file = path.join(makeSandbox(), 'broken.json');
    writeFileSync(file, '{ 这不是 JSON', 'utf8');
    expect(caughtCode(() => loadBossKnowledgePack({ packFile: file }))).toBe('KNOWLEDGE_PACK_INVALID');
  });
});
