import { describe, expect, it } from 'vitest';
import { resolveNavigableUrl } from './navigate-policy.js';

/**
 * 已登记平台及其声明的可导航源（P8 8.1-05 的新口径：名单来自知识包的 `origins`，不再是 startUrl 的源）。
 *
 * `fixture` 挂本地回环与另一个 https 源，是为了能分别演「回环免签字」与「真源要签字」两条腿。
 */
const PLATFORMS = [
  { id: 'fixture', origins: ['http://127.0.0.1:10233', 'https://fixture.example.com'] },
  { id: 'boss', origins: ['https://www.zhipin.com'] },
];

/**
 * 跑一次许可判定并取回结构化错误的码。
 * @param call 被检的判定调用
 * @returns 错误码；判定成功（没抛）时为 null
 */
const errorCode = (call: () => unknown): string | null => {
  try {
    call();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? null;
  }
};

describe('导航许可判定（spec 2.1-03 / 2.1-04 / 8.1-05）', () => {
  it('已登记平台的同源地址放行，路径与查询串原样保留', () => {
    const target = resolveNavigableUrl('http://127.0.0.1:10233/boss/detail?job=1001', PLATFORMS);
    expect(target.origin).toBe('http://127.0.0.1:10233');
    expect(target.pathname).toBe('/boss/detail');
    expect(target.searchParams.get('job')).toBe('1001');
  });

  it('一个平台声明多个源时都放行（真实站的登录域与主域是同一份知识）', () => {
    expect(resolveNavigableUrl('https://www.zhipin.com/web/geek/jobs', PLATFORMS, ['boss']).origin).toBe(
      'https://www.zhipin.com',
    );
    expect(resolveNavigableUrl('https://fixture.example.com/search', PLATFORMS, ['fixture']).host).toBe(
      'fixture.example.com',
    );
  });

  it('跨源一律拒绝，并把允许的源带回 details 供界面显示', () => {
    // 第三方源用 RFC 保留名 `other.example`：这条要判的是「不在登记名单里」，与域名真假无关，
    // 而测试面不许出现可注册的真实域名（AGENTS.md §7.2）。
    expect(errorCode(() => resolveNavigableUrl('https://other.example/job/1', PLATFORMS, ['boss']))).toBe(
      'NAVIGATE_URL_REJECTED',
    );
    expect(() => resolveNavigableUrl('https://other.example/job/1', PLATFORMS, ['boss'])).toThrow(
      /不属于任何已登记平台/,
    );
  });

  it('协议白名单只含 http/https：javascript: 与 data: 都会被拦下', () => {
    expect(errorCode(() => resolveNavigableUrl('javascript:alert(1)', PLATFORMS))).toBe('NAVIGATE_URL_REJECTED');
    expect(errorCode(() => resolveNavigableUrl('data:text/html,<script>a</script>', PLATFORMS))).toBe(
      'NAVIGATE_URL_REJECTED',
    );
    expect(errorCode(() => resolveNavigableUrl('file:///C:/Windows/win.ini', PLATFORMS))).toBe('NAVIGATE_URL_REJECTED');
  });

  it('同源但换端口的地址算另一个源，同样拒绝', () => {
    expect(errorCode(() => resolveNavigableUrl('http://127.0.0.1:9999/boss', PLATFORMS))).toBe('NAVIGATE_URL_REJECTED');
  });

  it('根本不是地址时以同一码失败，不抛解析层的裸异常', () => {
    expect(errorCode(() => resolveNavigableUrl('boss/detail', PLATFORMS))).toBe('NAVIGATE_URL_REJECTED');
    expect(() => resolveNavigableUrl('boss/detail', PLATFORMS)).toThrow(/无法解析/);
  });

  it('空登记名单时任何地址都进不去（宁可全拒也不放行）', () => {
    expect(errorCode(() => resolveNavigableUrl('http://127.0.0.1:10233/boss', []))).toBe('NAVIGATE_URL_REJECTED');
  });

  /**
   * 第二道闸门（spec 8.1-05）：真源的光「登记了」不够，还要平台有一份 `automation:<platform>` 签字。
   *
   * 这条判据与拒跨源分开码：`CONSENT_REQUIRED` 是「等人按确认」，界面据此画出风险确认卡；
   * `NAVIGATE_URL_REJECTED` 是「这个地址根本不在范围内」，按确认也不会变通。
   */
  it('源已登记但平台没签字：以 CONSENT_REQUIRED 失败，不带地址进内核', () => {
    expect(errorCode(() => resolveNavigableUrl('https://www.zhipin.com/web/geek/jobs', PLATFORMS, []))).toBe(
      'CONSENT_REQUIRED',
    );
    expect(() => resolveNavigableUrl('https://www.zhipin.com/web/geek/jobs', PLATFORMS, [])).toThrow(/boss/);
  });

  it('回环源不要求签字（本地仿站是自动化验收面，AGENTS.md §7.2）', () => {
    expect(errorCode(() => resolveNavigableUrl('http://127.0.0.1:10233/boss', PLATFORMS, []))).toBeNull();
  });

  it('签字判据只看地址真正归属的那个平台，别的平台签过字不算', () => {
    expect(errorCode(() => resolveNavigableUrl('https://www.zhipin.com/web/geek/jobs', PLATFORMS, ['fixture']))).toBe(
      'CONSENT_REQUIRED',
    );
  });
});
