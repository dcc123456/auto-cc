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
 * - `/locator` 是**定位策略靶页**（testid / role+可读名 / 可见文本 / CSS / XPath 各一块），
 *   带一个「延迟插入」按钮（800ms 后才出现的节点，spec 2.2-03 要观察器等待而不是轮询）和
 *   `?variant=before|after` 两份 DOM —— `after` 只改一个 `data-testid` 并去掉一个类，
 *   tagName / role / 可读名 / 祖先结构全部不变，正是 2.2-05 指纹自愈的输入；
 * - `/chat` 把聊天区放进**同源 iframe**（`/chat/frame`），帧内输入框与发送按钮把消息
 *   POST 到 `/api/outbound`，主页面显示帧内 postMessage 与服务端收件计数两路读数（spec 2.2-10 / 2.2-13）；
 * - `/newtab` 有 `target=_blank` 链接与 `window.open()` 按钮两个入口，`/newtab/target`
 *   回显自身 location 与 `document.cookie` —— 新标签有没有被接管进同一分区，看它读不读得到会话 cookie（spec 2.2-11）；
 * - `/trusted` 把 `mousedown/click/input` 的 `{type,isTrusted,inputType,value}` 记进
 *   `window.__autoCcTrustReadings` 并 POST 到 `/api/trust`（`GET /api/trust` 读回同一份），
 *   受通道是否产出受信事件、中文与 emoji 有没有乱码，都由这份对端读数说（spec 2.2-12 / 2.2-13）；
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
const locatorPage = path.join(repoRoot, 'fixtures', 'self-test-lab', 'locator-lab.html');
const chatPage = path.join(repoRoot, 'fixtures', 'self-test-lab', 'chat-lab.html');
const newtabPage = path.join(repoRoot, 'fixtures', 'self-test-lab', 'newtab-lab.html');
const trustPage = path.join(repoRoot, 'fixtures', 'self-test-lab', 'trust-lab.html');
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
  '/locator': '/locator',
  '/chat': '/chat',
  '/newtab': '/newtab',
  '/trusted': '/trusted',
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

/** 受信事件读数（2.2-12 / 2.2-13 用）：由 `/trusted` 整份上报，GET 读回的就是页面上那张表。 */
let trustReadings: unknown[] = [];

/**
 * 聊天帧内外发时写的目标 id。
 * 帧内 DOM、外发体、父页断言三处必须同一个值，所以在这里定一次，不给它第二个副本（§2.5）。
 */
const chatTargetId = 'fixture-job-1001';

/**
 * `/chat/frame` 的内容：同源 iframe 里的输入框与发送按钮（spec 2.2-10 的靶子）。
 * 这张子视图与父页是同一个验收动作的两半（帧内敲字、父页报状态），拆成独立文件反而看不出耦合，故就地内联。
 */
const chatFramePageHtml = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>聊天区（同源 iframe）· 本地 fixture</title>
    <style>
      body {
        margin: 0;
        padding: 12px;
        font: 13px/1.7 system-ui, sans-serif;
        color: #e2e8f0;
        background: #111c31;
      }
      code {
        color: #7dd3fc;
      }
      textarea,
      button {
        font: inherit;
        padding: 4px 10px;
        border-radius: 6px;
        border: 1px solid #334155;
        background: #1e293b;
        color: #e2e8f0;
      }
      textarea {
        box-sizing: border-box;
        width: 100%;
        background: #020617;
      }
      ul {
        padding-left: 18px;
      }
    </style>
  </head>
  <body data-fixture-page="chat-frame">
    <p>聊天区在帧内：<code>/chat/frame</code>（同源 iframe）—— 帧外的自动化必须换算坐标才点得到这里。</p>
    <p>打招呼目标：<code data-testid="chat-target">${chatTargetId}</code></p>
    <p><textarea data-testid="chat-input" rows="3" placeholder="输入打招呼文案（含中文与 emoji）"></textarea></p>
    <p><button type="button" data-testid="chat-send">发送打招呼</button></p>
    <p>帧内状态：<strong data-testid="chat-frame-status">待发送</strong></p>
    <ul data-testid="chat-log"></ul>
    <script>
      const chatInput = document.querySelector('[data-testid="chat-input"]');
      const chatLog = document.querySelector('[data-testid="chat-log"]');
      const frameStatus = document.querySelector('[data-testid="chat-frame-status"]');

      /** 发出一次打招呼：先落帧内 DOM（截图看得见），再走 /api/outbound（对端数得清）。 */
      function sendGreeting() {
        const text = chatInput.value;
        // action 与 targetId 是 /api/outbound 的必填字符串字段，缺一个就被 400 拒掉，验收会当场暴露。
        fetch('/api/outbound', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'greet', targetId: '${chatTargetId}', text, frameUrl: location.pathname }),
        })
          .then((response) => response.json())
          .then((payload) => {
            const line = document.createElement('li');
            line.dataset.testid = 'chat-log-item';
            // 用 textContent 而不是拼 HTML：中文与 emoji 要按字面出现在帧内（spec 2.2-13）。
            line.textContent = text;
            chatLog.append(line);
            frameStatus.textContent = '第 ' + String(payload.received) + ' 条已送达服务端';
            chatInput.value = '';
            // 状态由帧内报给父页：父页显示的每一条都追溯到「iframe 里确实点过」。
            window.parent.postMessage({ type: 'chat-outbound', received: payload.received, text }, window.location.origin);
          })
          .catch((error) => {
            frameStatus.textContent = '发送失败：' + String(error);
          });
      }

      document.querySelector('[data-testid="chat-send"]').addEventListener('click', sendGreeting);
    </script>
  </body>
</html>
`;

/** `/newtab/target` 的内容：新标签被接管后，这页的 location 与 cookie 就是分区一致性的读数（spec 2.2-11）。 */
const newtabTargetPageHtml = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>新标签目标页 · 本地 fixture</title>
    <style>
      body {
        margin: 0;
        padding: 16px;
        font: 13px/1.7 system-ui, sans-serif;
        color: #e2e8f0;
        background: #0f172a;
      }
      code {
        color: #7dd3fc;
        word-break: break-all;
      }
    </style>
  </head>
  <body data-fixture-page="newtab-target">
    <h1>新标签目标页</h1>
    <p>本地 fixture 站点（AGENTS.md §7.2），由 <code>/newtab</code> 的两条入口唤出。</p>
    <p>当前地址：<code data-testid="target-url">（脚本未运行）</code></p>
    <p>document.cookie：<code data-testid="target-cookie">（空）</code></p>
    <p>cookie 名：<code data-testid="target-cookie-names">（空）</code></p>
    <p>判定：读得到 <code>autocc_session</code> 才说明新页面和发起页落在同一个会话分区。</p>
    <script>
      document.querySelector('[data-testid="target-url"]').textContent = window.location.href;
      document.querySelector('[data-testid="target-cookie"]').textContent = document.cookie || '（空）';
      // 名字单独列一份：证据里只留名字不留值，跟 /api/state 的口径一致。
      document.querySelector('[data-testid="target-cookie-names"]').textContent =
        document.cookie
          .split(';')
          .map((pair) => pair.trim().split('=')[0])
          .filter(Boolean)
          .sort()
          .join(', ') || '（空）';
    </script>
  </body>
</html>
`;

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
 * 回一份静态 HTML。
 * @param response 待写的响应
 * @param html 页面内容（已做过占位替换或本身就是静态子视图）
 */
function sendHtml(response: ServerResponse, html: string): void {
  // no-store 是必需的：验收截图一旦拿到缓存里的旧 DOM，判据就跟当前实现错位了。
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(html);
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

  // 2.2-12 / 2.2-13 的对端读数：页面把 isTrusted / inputType / value 整份报上来。
  if (url.pathname === '/api/trust' && request.method === 'POST') {
    const body = await readJson(request, response);
    if (body === null) return;
    const readings = body?.['readings'];
    if (!Array.isArray(readings)) {
      response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: '缺少 readings 数组' }));
      return;
    }
    // 覆盖而不是追加：上报的就是页面上那张表的全部行，追加会让 GET 与截图数不上行号。
    trustReadings = readings;
    console.log(`[fixture] 收到 ${String(trustReadings.length)} 条受信事件读数`);
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ok: true, count: trustReadings.length }));
    return;
  }

  if (url.pathname === '/api/trust') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ count: trustReadings.length, readings: trustReadings }));
    return;
  }

  if (url.pathname === '/api/state') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ loggedIn, cookieNames: cookieNames(request.headers.cookie) }));
    return;
  }

  if (url.pathname === '/' || url.pathname === '/alt') {
    // 分区标签由路径决定，界面上肉眼可分：两张截图长得一样就没法证明隔离真的发生了。
    sendHtml(
      response,
      readFileSync(labPage, 'utf8').replaceAll('{{partitionLabel}}', url.pathname === '/alt' ? 'B' : 'A'),
    );
    return;
  }

  if (url.pathname === '/boss' || url.pathname === '/boss/detail') {
    const page = url.pathname === '/boss' ? bossSearchPage : bossDetailPage;
    // 登录横幅由服务端按请求里的 cookie 现判：让页面自己声明登录态就成了自述，
    // 而 2.1-05 要的恰恰是「分区里那份 cookie 真的还带着」——它必须是对端的读数。
    sendHtml(
      response,
      readFileSync(page, 'utf8')
        .replaceAll('{{loggedIn}}', loggedIn ? 'true' : 'false')
        .replaceAll('{{authLabel}}', loggedIn ? '已登录' : '未登录'),
    );
    return;
  }

  if (url.pathname === '/locator') {
    // 改版前后两份 DOM 由页面自己按 ?variant= 渲染，服务端不分支：
    // 自愈比对的输入必须来自同一份静态文件，否则「结构没变」这句话就成了服务端保证的。
    sendHtml(response, readFileSync(locatorPage, 'utf8'));
    return;
  }

  if (url.pathname === '/chat') {
    sendHtml(response, readFileSync(chatPage, 'utf8'));
    return;
  }

  if (url.pathname === '/chat/frame') {
    sendHtml(response, chatFramePageHtml);
    return;
  }

  if (url.pathname === '/newtab') {
    sendHtml(response, readFileSync(newtabPage, 'utf8'));
    return;
  }

  if (url.pathname === '/newtab/target') {
    sendHtml(response, newtabTargetPageHtml);
    return;
  }

  if (url.pathname === '/trusted') {
    sendHtml(response, readFileSync(trustPage, 'utf8'));
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
  // 路由清单打在启动日志里：验收脚本按这份列表逐条 curl，不用回头翻代码。
  console.log(
    `[fixture] 实验台已启动：http://${host}:${String(port)}/ · /alt · /boss · /locator · /chat · /newtab · /trusted（cookie ${cookieName}）`,
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
