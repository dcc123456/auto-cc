import { describe, expect, it } from 'vitest';
import { decideTakeover, topmostAlive } from './view-takeover.js';

/**
 * 把判定结局压成一句可断言的文本：放行时为 `accepted`，拒绝时为拒绝原因。
 * @param rawUrl 页面请求打开的地址（外部页面的不可信输入）
 * @param pageUrl 发起页地址，即内核视图当前 URL
 * @returns 放行/拒绝原因文本，用来同时断言「拒了」和「为什么拒」
 */
const verdictOf = (rawUrl: string, pageUrl: string): string => {
  const decision = decideTakeover(rawUrl, pageUrl);
  return decision.isAccepted ? 'accepted' : decision.reason;
};

describe('新标签接管准入判定（spec 2.2-11）', () => {
  const PAGE_URL = 'http://127.0.0.1:10233/newtab';

  it('同源的新标签地址被接管，路径与查询串原样保留', () => {
    const decision = decideTakeover('http://127.0.0.1:10233/newtab/target?job=1001', PAGE_URL);
    expect(decision.isAccepted).toBe(true);
    if (decision.isAccepted) {
      expect(decision.targetUrl.origin).toBe('http://127.0.0.1:10233');
      expect(decision.targetUrl.pathname).toBe('/newtab/target');
      expect(decision.targetUrl.searchParams.get('job')).toBe('1001');
    }
  });

  it('协议只放 http/https：javascript: 与 data: 不进视图', () => {
    expect(verdictOf('javascript:alert(1)', PAGE_URL)).toMatch(/不允许的协议 javascript:/);
    expect(verdictOf('data:text/html,<script>a</script>', PAGE_URL)).toMatch(/不允许的协议 data:/);
    expect(verdictOf('file:///C:/Windows/win.ini', PAGE_URL)).toMatch(/不允许的协议 file:/);
  });

  it('跨源一律拒绝，连同站的另一主机也拒', () => {
    expect(verdictOf('https://example.com/job/1', PAGE_URL)).toMatch(/跨源/);
    expect(verdictOf('http://localhost:10233/newtab/target', PAGE_URL)).toMatch(/跨源/);
    // 换端口是另一个源：同源判定不能只看主机名
    expect(verdictOf('http://127.0.0.1:9999/newtab/target', PAGE_URL)).toMatch(/跨源/);
  });

  it('发起页还不是真实站点（占位页 / 装载中空地址）时不接管', () => {
    expect(verdictOf('http://127.0.0.1:10233/newtab/target', 'data:text/html;charset=utf-8,placeholder')).toMatch(
      /跨源/,
    );
    expect(verdictOf('http://127.0.0.1:10233/newtab/target', '')).toMatch(/发起页地址不可解析/);
  });

  it('根本不是地址时以拒绝原因返回，不抛出（调用处在 Electron 事件回调里）', () => {
    expect(verdictOf('not a url', PAGE_URL)).toMatch(/无法解析/);
  });
});

/** 一个只有"页面是否还活着"这条信息的子视图替身，用来在没有窗口的环境里测栈序。 */
type ChildDouble = { id: string; isAlivePage: boolean };

describe('接管子视图的活动页选择（spec 2.2-11 / 2.1-11）', () => {
  const stack: ChildDouble[] = [
    { id: 'first', isAlivePage: true },
    { id: 'second', isAlivePage: true },
  ];
  const pick = (views: ChildDouble[]): string | null => topmostAlive(views, (view) => view.isAlivePage)?.id ?? null;

  it('栈顶（最后创建的那一个）才是用户看到的页面', () => {
    expect(pick(stack)).toBe('second');
  });

  it('栈顶的页面刚被自己关掉时，回落到下面的那个而不是交出死句柄', () => {
    expect(
      pick([
        { id: 'first', isAlivePage: true },
        { id: 'second', isAlivePage: false },
      ]),
    ).toBe('first');
  });

  it('空栈与全死栈都返回 null，调用方据此回到内核视图本身', () => {
    expect(pick([])).toBeNull();
    expect(pick([{ id: 'first', isAlivePage: false }])).toBeNull();
  });
});
