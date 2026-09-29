/**
 * 1.8 验收用的本地 fixture HTTP 服务（AGENTS.md §7.2：自动化测试一律打本地站点）。
 *
 * 只绑 `127.0.0.1`，且拒绝任何其他 host 的绑定请求 —— 它模拟的是「已登录的招聘站」，
 * 暴露到局域网就没有「不碰真实平台」这条保证了。
 *
 * 三条能力刚好覆盖 1.8 的三条验收：
 * - `/login` 写一份 **带 Max-Age 的持久 cookie**（会话型 cookie 不会被 Chromium 落盘，
 *   用它验 1.8-03 的「跨重启保持」会测到假阴性）；
 * - `/` 与 `/alt` 是同一个站点、同一个 cookie 名的两条路径，用来证明隔离发生在**分区**
 *   而不是域名上（spec 1.8-01）；
 * - 进程可以被独立停掉，这就是 1.8-09「站点不可达要有明确错误态」的开关。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const labPage = path.join(repoRoot, 'fixtures', 'self-test-lab', 'session-lab.html');
const host = '127.0.0.1';
const port = Number(process.env.FIXTURE_PORT ?? 10233);
const cookieName = 'autocc_session';

/** 解析请求头里的 cookie，只回名字 —— 证据文件里也不该出现值。 */
function cookieNames(header: string | undefined): string[] {
  return (header ?? '')
    .split(';')
    .map((pair) => pair.trim().split('=')[0] ?? '')
    .filter(Boolean)
    .sort();
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${host}:${String(port)}`);
  const loggedIn = cookieNames(request.headers.cookie).includes(cookieName);

  if (url.pathname === '/login' || url.pathname === '/logout') {
    const isLogin = url.pathname === '/login';
    // Max-Age=0 让 Chromium 立刻丢掉这条 cookie，等价于站点自己的「退出登录」。
    response.setHeader('Set-Cookie', `${cookieName}=fixture-token; Path=/; Max-Age=${isLogin ? '86400' : '0'}`);
    response.writeHead(302, { Location: '/' });
    response.end();
    return;
  }

  if (url.pathname === '/api/state') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ loggedIn, cookieNames: cookieNames(request.headers.cookie) }));
    return;
  }

  if (url.pathname === '/' || url.pathname === '/alt') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    // 分区标签由路径决定，界面上肉眼可分：两张截图长得一样就没法证明隔离真的发生了。
    response.end(readFileSync(labPage, 'utf8').replaceAll('{{partitionLabel}}', url.pathname === '/alt' ? 'B' : 'A'));
    return;
  }

  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('not found');
});

server.listen(port, host, () => {
  console.log(`[fixture] 会话实验台已启动：http://${host}:${String(port)}/ 与 /alt（cookie ${cookieName}）`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
