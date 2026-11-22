import { describe, expect, it } from 'vitest';
import { resolveNavigableUrl } from './navigate-policy.js';

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

describe('导航许可判定（spec 2.1-03 / 2.1-04，2026-11-22 裁定：真实浏览器）', () => {
  it('任意 http/https 地址都放行，路径与查询串原样保留', () => {
    const target = resolveNavigableUrl('http://127.0.0.1:10233/boss/detail?job=1001');
    expect(target.origin).toBe('http://127.0.0.1:10233');
    expect(target.pathname).toBe('/boss/detail');
    expect(target.searchParams.get('job')).toBe('1001');
  });

  it('未登记来源同样放行（不再有平台名单，也没有回环特例）', () => {
    // 第三方源用 RFC 保留名 `other.example`：测试面不许出现可注册的真实域名（AGENTS.md §7.2）。
    expect(resolveNavigableUrl('https://other.example/job/1').host).toBe('other.example');
    expect(resolveNavigableUrl('https://www.zhipin.com/web/geek/jobs').origin).toBe('https://www.zhipin.com');
    // 同一台主机换端口的地址也是另一个网页，浏览器该能去。
    expect(resolveNavigableUrl('http://127.0.0.1:9999/boss').port).toBe('9999');
  });

  it('协议白名单只含 http/https：javascript: / data: / file: 都会被拦下', () => {
    expect(errorCode(() => resolveNavigableUrl('javascript:alert(1)'))).toBe('NAVIGATE_URL_REJECTED');
    expect(errorCode(() => resolveNavigableUrl('data:text/html,<script>a</script>'))).toBe('NAVIGATE_URL_REJECTED');
    expect(errorCode(() => resolveNavigableUrl('file:///C:/Windows/win.ini'))).toBe('NAVIGATE_URL_REJECTED');
  });

  it('协议被拒时 details 里带回原文，界面能照着显示', () => {
    try {
      resolveNavigableUrl('javascript:alert(1)');
      expect.unreachable('协议不在白名单内时必须抛');
    } catch (error) {
      expect((error as { details?: { url?: string } }).details?.url).toBe('javascript:alert(1)');
    }
  });

  it('根本不是地址时以同一码失败，不抛解析层的裸异常', () => {
    expect(errorCode(() => resolveNavigableUrl('boss/detail'))).toBe('NAVIGATE_URL_REJECTED');
    expect(() => resolveNavigableUrl('boss/detail')).toThrow(/无法解析/);
    expect(errorCode(() => resolveNavigableUrl(''))).toBe('NAVIGATE_URL_REJECTED');
  });
});
