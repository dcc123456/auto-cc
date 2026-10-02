/**
 * harness 的本地地址守卫（spec 4.4-08 的运行期半边，判据见 plan §4.4-e 判据二）。
 *
 * AGENTS.md §7.2 说"自动化测试不得访问真实招聘平台"。`check-compliance-redlines.ts` 规则三管的是
 * **写死的字符串**，但 `pnpm harness open --to <url>` 的 URL 是人在现场敲的、或从变量里拼出来的，
 * 字符串面看不见它——所以真正发命令之前还有一道闸。这里测的就是那道闸的判定。
 *
 * 用例里的"远端主机"一律用 RFC 保留名（`*.test.invalid` / `*.example`）而不是真实平台域名：
 * 它们公网不可达，同时又能让规则三放行——**保留名恰好是"既出不了网、又能被判成非本地"的那一类**，
 * 拿真域名写在这里反而会被自己的机检拦下（那是设计，不是巧合）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { localTestUrlViolation } from './cdp.js';

describe('本地地址守卫放行（harness 的正常用法）', () => {
  it.each([
    // app 自己的渲染层与 fixture 站点。
    ['http://127.0.0.1:5173/'],
    ['http://localhost:10233/chat/frame'],
    // CDP 调试端口的三种写法（IPv6 的方括号形态由 URL 解析器带出来）。
    ['http://[::1]:10222/json/list'],
    ['ws://localhost:10222/devtools/page/ABC'],
    // 大小写不敏感：手敲 URL 时 `HTTP://LOCALHOST` 是常见形态。
    ['HTTP://LOCALHOST:10233/'],
    // 本地 HTTPS fixture（自签证书，仍在回环里）。
    ['https://127.0.0.1:10233/boss'],
    // 打开本机产物看一眼（导出 PDF / 截图）不出网。
    ['file:///D:/works/auto-cc/tmp/shot.png'],
  ])('%s 放行', (url) => {
    expect(localTestUrlViolation(url)).toBeNull();
  });
});

describe('本地地址守卫拒绝（会把请求发出去的那些）', () => {
  it('远端主机：非回环就不放行', () => {
    expect(localTestUrlViolation('https://model.test.invalid/v1')).toContain('不是本地地址');
    // 主机取 RFC 保留名，路径保持普通形态：写 `/embeddings` 会被 `check-llm-single-entry` 当成模型调用。
    expect(localTestUrlViolation('https://embed.test.invalid/v1')).toContain('不是本地地址');
    expect(localTestUrlViolation('https://job.example/search')).toContain('不是本地地址');
  });

  it('后缀混淆：主机名以 localhost 开头但并不是它', () => {
    // 判定按整个主机名而不是 `startsWith`，否则 `localhost.attacker.example` 就混进去了。
    expect(localTestUrlViolation('http://localhost.attacker.example:10222/')).toContain('不是本地地址');
  });

  it('非本地协议：既不是四类传输协议也不是 file', () => {
    expect(localTestUrlViolation('javascript:document.body.innerText')).toContain('不在本地测试白名单内');
    expect(localTestUrlViolation('data:text/html,<h1>hi</h1>')).toContain('不在本地测试白名单内');
  });

  it('判不出主机的写法：相对地址与协议相对地址一律拒绝', () => {
    // 相对地址在 CDP 里会被按当前 target 解析成任意站点，静态上无从证明它不出网。
    expect(localTestUrlViolation('/chat/frame')).toContain('不是完整 URL');
    expect(localTestUrlViolation('//job.example/search')).toContain('不是完整 URL');
    expect(localTestUrlViolation('')).toContain('不是完整 URL');
  });
});

describe('守卫确实接在导航入口上（摘掉调用就红，不靠人记住）', () => {
  /**
   * 结构面断言，理由同 §10 里"零上行审计"那套：这里没有真的 socket 可控，
   * 但"先判地址、后发命令"这件事的顺序是写得出来的，顺序错就等于守卫形同虚设。
   */
  it('navigate 在发出 Page.navigate 之前调用 localTestUrlViolation', () => {
    const source = readFileSync(join(import.meta.dirname, 'cdp.ts'), 'utf8');
    const method = /async navigate\(url: string\): Promise<void> \{([\s\S]*?)\n  \}/.exec(source)?.[1];
    if (!method) throw new Error('CdpSession.navigate 的方法体没匹配上，守卫断言失去意义');
    const guardAt = method.indexOf('localTestUrlViolation(url)');
    const sendAt = method.indexOf("this.send('Page.navigate'");
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(sendAt).toBeGreaterThanOrEqual(0);
    // 抛错必须在 throw 里而不是只打印：调用方（cli 的 open 子命令）靠异常决定退出码。
    expect(method.slice(guardAt, sendAt)).toContain('throw new Error');
    expect(guardAt).toBeLessThan(sendAt);
  });
});
