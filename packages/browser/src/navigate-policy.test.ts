import { describe, expect, it } from 'vitest';
import { resolveNavigableUrl } from './navigate-policy.js';

/** 已登记平台的起始地址：与 `cordis.yml` 里同形（本地仿站 + 另一个源，用来证明跨源被拒）。 */
const START_URLS = ['http://127.0.0.1:10233/boss', 'https://fixture.example.com/'];

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

describe('导航许可判定（spec 2.1-03 / 2.1-04）', () => {
  it('已登记平台的同源地址放行，路径与查询串原样保留', () => {
    const target = resolveNavigableUrl('http://127.0.0.1:10233/boss/detail?job=1001', START_URLS);
    expect(target.origin).toBe('http://127.0.0.1:10233');
    expect(target.pathname).toBe('/boss/detail');
    expect(target.searchParams.get('job')).toBe('1001');
  });

  it('登记平台是 https 时，同源也放行', () => {
    expect(resolveNavigableUrl('https://fixture.example.com/search', START_URLS).host).toBe('fixture.example.com');
  });

  it('跨源一律拒绝，并把允许的源带回 details 供界面显示', () => {
    expect(errorCode(() => resolveNavigableUrl('https://zhipin.com/web/geek/job', START_URLS))).toBe(
      'NAVIGATE_URL_REJECTED',
    );
    expect(() => resolveNavigableUrl('https://zhipin.com/web/geek/job', START_URLS)).toThrow(/不属于任何已登记平台/);
  });

  it('协议白名单只含 http/https：javascript: 与 data: 都会被拦下', () => {
    expect(errorCode(() => resolveNavigableUrl('javascript:alert(1)', START_URLS))).toBe('NAVIGATE_URL_REJECTED');
    expect(errorCode(() => resolveNavigableUrl('data:text/html,<script>a</script>', START_URLS))).toBe(
      'NAVIGATE_URL_REJECTED',
    );
    expect(errorCode(() => resolveNavigableUrl('file:///C:/Windows/win.ini', START_URLS))).toBe(
      'NAVIGATE_URL_REJECTED',
    );
  });

  it('同源但换端口的地址算另一个源，同样拒绝', () => {
    expect(errorCode(() => resolveNavigableUrl('http://127.0.0.1:9999/boss', START_URLS))).toBe(
      'NAVIGATE_URL_REJECTED',
    );
  });

  it('根本不是地址时以同一码失败，不抛解析层的裸异常', () => {
    expect(errorCode(() => resolveNavigableUrl('boss/detail', START_URLS))).toBe('NAVIGATE_URL_REJECTED');
    expect(() => resolveNavigableUrl('boss/detail', START_URLS)).toThrow(/无法解析/);
  });

  it('空登记名单时任何地址都进不去（宁可全拒也不放行）', () => {
    expect(errorCode(() => resolveNavigableUrl('http://127.0.0.1:10233/boss', []))).toBe('NAVIGATE_URL_REJECTED');
  });
});
