/**
 * 验收用的本地 fixture HTTP 服务（AGENTS.md §7.2：自动化测试一律打本地站点）。
 *
 * 只绑 `127.0.0.1`，且拒绝任何其他 host 的绑定请求 —— 它模拟的是「已登录的招聘站」，
 * 暴露到局域网就没有「不碰真实平台」这条保证了。
 *
 * 能力覆盖 1.8 / 1.9 / 2.1 的验收：
 * - `/login` 写一份 **带 Max-Age 的持久 cookie**（会话型 cookie 不会被 Chromium 落盘，
 *   用它验 1.8-03 的「跨重启保持」会测到假阴性）；`?next=` 决定登录完回到哪一页；
 * - `/` 与 `/alt` 是同一个站点、同一个 cookie 名的两条路径，用来证明隔离发生在**分区**
 *   而不是域名上（spec 1.8-01）；
 * - `/boss` 与 `/boss/detail` 是**本地仿招聘站**（列表 + 详情），DOM 结构刻意模仿但不含任何
 *   真实平台代码与数据，登录横幅按请求 cookie 现判（spec 2.1-03 / 2.1-05）；
 * - `POST /api/outbound` 与 `GET /api/outbox` 是 1.9 的**样例收件箱**：外发是否真的发生，
 *   由这里的计数说，而不是由 app 自述（spec 1.9-03 / 1.9-04）；
 * - 进程可以被独立停掉，这就是 1.8-09「站点不可达要有明确错误态」的开关。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const labPage = path.join(repoRoot, 'fixtures', 'self-test-lab', 'session-lab.html');
const bossSearchPage = path.join(repoRoot, 'fixtures', 'self-test-lab', 'boss-search.html');
const bossDetailPage = path.join(repoRoot, 'fixtures', 'self-test-lab', 'boss-detail.html');
const host = '127.0.0.1';
const port = Number(process.env.FIXTURE_PORT ?? 10233);
const cookieName = 'autocc_session';

/**
 * 登录后允许回跳的目标（spec 2.1-05 需要在仿站里「登录 → 回到原页」）。
 * 只认这几个已知页面：`next` 直接来自查询串，放开成任意值就是本站自己的开放式跳转。
 */
const loginTargets: Record<string, string> = {
  '/': '/',
  '/alt': '/alt',
  '/boss': '/boss',
  '/boss/detail': '/boss/detail',
};

/** 解析请求头里的 cookie，只回名字 —— 证据文件里也不该出现值。 */
function cookieNames(header: string | undefined): string[] {
  return (header ?? '')
    .split(';')
    .map((pair) => pair.trim().split('=')[0] ?? '')
    .filter(Boolean)
    .sort();
}

/**
 * 样例收件箱（1.9 用）。
 * 「消息真的出去了」由对端计数证明，app 自述不算（plan §8.4）。
 */
const outbox: unknown[] = [];

/**
 * 读完请求体再回调；上限 64 KB，避免样例端点被当成缓冲区滥用。
 * @returns 解析后的对象；体不是合法 JSON 时 `undefined`，超限并已就地回了 413 时 `null`
 */
function readJson(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<Record<string, unknown> | undefined | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        response.writeHead(413).end();
        request.destroy();
        // destroy 之后不会再有 end，必须在这里定下来，否则调用方永远悬着。
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        // 只能 Buffer.concat：Buffer.from(缓冲数组) 按字节数组解释，会把每个分片变成 0x00。
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      } catch {
        resolve(undefined);
      }
    });
  });
}

/**
 * 处理一次实验台请求。
 * @param request 进来的请求（`/api/outbound` 需要先读完请求体，所以是 async）
 * @param response 待写的响应
 */
async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${host}:${String(port)}`);
  const loggedIn = cookieNames(request.headers.cookie).includes(cookieName);

  if (url.pathname === '/login' || url.pathname === '/logout') {
    const isLogin = url.pathname === '/login';
    // Max-Age=0 让 Chromium 立刻丢掉这条 cookie，等价于站点自己的「退出登录」。
    response.setHeader('Set-Cookie', `${cookieName}=fixture-token; Path=/; Max-Age=${isLogin ? '86400' : '0'}`);
    // 回跳到发起登录的那一页：登录态要能在**同一张页面**上前后对照（spec 2.1-05 的截图判据）。
    response.writeHead(302, { Location: loginTargets[url.searchParams.get('next') ?? '/'] ?? '/' });
    response.end();
    return;
  }

  // 1.9 的样例收件端点：记下这一条，并回「我是第几条收到的」。
  if (url.pathname === '/api/outbound' && request.method === 'POST') {
    const body = await readJson(request, response);
    if (body === null) return;
    if (!body || typeof body['action'] !== 'string' || typeof body['targetId'] !== 'string') {
      response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: '缺少 action / targetId' }));
      return;
    }
    outbox.push({ ...body, receivedAt: Date.now() });
    console.log(`[fixture] 收到第 ${String(outbox.length)} 条外发：${body['action']} → ${body['targetId']}`);
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ok: true, received: outbox.length }));
    return;
  }

  if (url.pathname === '/api/outbox') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ count: outbox.length, items: outbox }));
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

  if (url.pathname === '/boss' || url.pathname === '/boss/detail') {
    const page = url.pathname === '/boss' ? bossSearchPage : bossDetailPage;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    // 登录横幅由服务端按请求里的 cookie 现判：让页面自己声明登录态就成了自述，
    // 而 2.1-05 要的恰恰是「分区里那份 cookie 真的还带着」——它必须是对端的读数。
    response.end(
      readFileSync(page, 'utf8')
        .replaceAll('{{loggedIn}}', loggedIn ? 'true' : 'false')
        .replaceAll('{{authLabel}}', loggedIn ? '已登录' : '未登录'),
    );
    return;
  }

  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('not found');
}

/** `createServer` 的回调只能同步返回，异步的处理函数交给 `void` 转交。 */
const server = createServer((request, response) => {
  void handle(request, response);
});

server.listen(port, host, () => {
  console.log(`[fixture] 会话实验台已启动：http://${host}:${String(port)}/ 与 /alt（cookie ${cookieName}）`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
