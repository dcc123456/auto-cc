/**
 * 窗口可见性闸的**可复跑机器读数**（spec 10.6-02 / 10.10-22，2026-11-24 QA 的 P0 返工）。
 *
 * 为什么需要一条脚本而不是靠 `osascript`：macOS 上把应用藏起来这条路在本机三次都造不出稳定的
 * `document.visibilityState === 'hidden'`（System Events 返回 0 却没真隐藏、AXMinimized 被辅助访问权限挡住），
 * 于是「隐藏态零 attempt」这一格一直是靠人现场演示的读数。这里改成**确定性的机器路径**：
 * 用 CDP 的 `Page.setWebLifecycleState({state:'frozen'})` 把内核视图那一页冻住——页面层
 * `document.visibilityState` 立刻变 `hidden`，而窗口对象与视图挂载状态**一个字都不变**，
 * 正是那道闸要判的形状（页面 hidden、`isVisible()` 仍 true）。
 *
 * 判据（任一不成立即非零退出）：
 * 1. 冻结前：内核页 `visible`、`getStatus().kernelViewPageVisible === true`；
 * 2. 冻结后：内核页 `hidden`、`kernelViewPageVisible === false`（**先断言，再调用**）；
 * 3. 此时调 `outbound.deliver.perform` → `OUTBOUND_WINDOW_NOT_VISIBLE`，且 attempts 零增；
 * 4. 解冻后可见 → 同一份请求能真发出去（账本 +1、追踪 `delivered`）。
 *
 * 纪律：只连本机仿站（§7.2）；用全新的 userData，不碰用户正在用的实例；不 import 主进程模块。
 * 跑法：`pnpm verify:window-gate`（可加 `--exe <可执行文件>` `--cdp-port 10267` `--fixture-port 10233`）
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { CdpSession, listTargets } from '../packages/testing/src/cdp.js';

const repoRoot = path.resolve(import.meta.dirname, '..');

/**
 * 读 `--key value` 形态的参数。
 * @param name 参数名（不含前导 `--`）
 * @param fallback 缺省值
 * @returns 参数字符串
 */
const flag = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
};

const cdpPort = Number(flag('cdp-port', '10267'));
const fixturePort = Number(flag('fixture-port', '10233'));
const userDataDir = path.join(repoRoot, 'tmp', 'verify-window-gate', `userdata-${String(Date.now())}`);

/**
 * 本机平台对应的解包产物（与发布冒烟同一份口径）。
 * @returns 可执行文件绝对路径
 */
const artifact = (): string => {
  const overrideIndex = process.argv.indexOf('--exe');
  const override = overrideIndex >= 0 ? process.argv[overrideIndex + 1] : undefined;
  if (override !== undefined) return path.resolve(repoRoot, override);
  if (process.platform === 'win32') return path.join(repoRoot, 'dist', 'win-unpacked', 'auto-cc.exe');
  if (process.platform === 'darwin')
    return path.join(repoRoot, 'dist', 'mac-arm64', 'auto-cc.app', 'Contents', 'MacOS', 'auto-cc');
  return path.join(repoRoot, 'dist', 'linux-unpacked', 'auto-cc');
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 逐条判据的失败原因；全空即通过。 */
const failures: string[] = [];
let checks = 0;

/**
 * 记一条判据。
 * @param ok 是否成立
 * @param label 判据原文（打印给人看）
 */
const check = (ok: boolean, label: string): void => {
  checks += 1;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} · ${label}\n`);
  if (!ok) failures.push(label);
};

type Reply<T> = { ok: true; value: T } | { ok: false; error: { code?: string; message?: string; details?: unknown } };

/**
 * 在页面里调一条白名单口。
 * @param session CDP 会话
 * @param apiPath 完整 path（命名空间按第一个点切）
 * @param args 位置实参
 * @returns 原始回包（不抛，判据要看 `ok:false` 的 code）
 */
async function callBridge<T>(session: CdpSession, apiPath: string, args: unknown[] = []): Promise<Reply<T>> {
  const dot = apiPath.indexOf('.');
  return session.evaluate<Reply<T>>(
    `(window.autoCC[${JSON.stringify(apiPath.slice(0, dot))}][${JSON.stringify(apiPath.slice(dot + 1))}](...${JSON.stringify(args)}))`,
  );
}

/** 极简 CDP 会话：只够发一条命令 + 读一段表达式（内核视图页不在渲染层会话里）。 */
interface RawCdp {
  send: (method: string, params?: unknown) => Promise<unknown>;
  evaluate: <T>(expression: string) => Promise<T>;
  close: () => void;
}

/**
 * 直连一个页面 target。
 * @param url websocket 调试地址
 * @returns 能发裸协议命令的会话
 */
async function attachRaw(url: string): Promise<RawCdp> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('内核页 CDP 连接失败')), { once: true });
  });
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message?: string } };
    if (message.id === undefined) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message ?? 'CDP 错误'));
    else waiter.resolve(message.result);
  });
  const send = (method: string, params?: unknown): Promise<unknown> => {
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params: params ?? {} }));
    });
  };
  const evaluate = async <T>(expression: string): Promise<T> => {
    const result = (await send('Runtime.evaluate', { expression, returnByValue: true })) as {
      result?: { value?: T };
    };
    return result.result?.value as T;
  };
  return { send, evaluate, close: () => socket.close() };
}

/** fixture 站点是否已经在听（认它自己的 JSON 接口）。 */
async function fixtureUp(): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(fixturePort)}/api/jobs?page=1&query=%E5%B2%97`);
    return response.ok && (response.headers.get('content-type') ?? '').includes('json');
  } catch {
    return false;
  }
}

/**
 * 等一个条件成立。
 * @param label 等的是什么（超时消息里用）
 * @param probe 返回真值即算成立
 * @param timeoutMs 上限
 * @returns 成立时的读数
 */
async function waitFor<T>(label: string, probe: () => Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await sleep(300);
  }
  throw new Error(`等不到：${label}`);
}

const main = async (): Promise<void> => {
  if (!(await fixtureUp())) {
    throw new Error(
      `本机仿站没在听（127.0.0.1:${String(fixturePort)}）：先起 \`pnpm fixture\`，本脚本只连仿站（§7.2）`,
    );
  }
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    path.join(userDataDir, 'settings.json'),
    `${JSON.stringify({ 'platform-boss': { pack: 'fixture' } }, null, 2)}\n`,
  );
  const exe = artifact();
  if (!existsSync(exe)) throw new Error(`找不到产物：${exe}（先 \`pnpm dist:mac\`）`);
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  const app = spawn(exe, [`--remote-debugging-port=${String(cdpPort)}`, `--user-data-dir=${userDataDir}`], {
    env,
    stdio: 'ignore',
  });
  process.stdout.write(`· 产物：${exe}\n· userData：${userDataDir}\n· CDP：${String(cdpPort)}\n`);

  const session = await waitFor(
    '产物渲染层 target',
    async () => {
      const targets = await listTargets(cdpPort).catch(() => []);
      if (!targets.some((target) => target.type === 'page' && target.url.includes('app.asar'))) return undefined;
      return CdpSession.attach(cdpPort, 'app.asar').catch(() => undefined);
    },
    90_000,
  );
  await sleep(3_000);

  await callBridge(session, 'sessions.grantConsent', ['boss']);
  await callBridge(session, 'sessions.open', ['fixture']);
  // 档位切到全自动：`suggest` 档在窗口闸之前就返回「只准备不发送」，验不到这道闸。
  await callBridge(session, 'chat.session.setAutonomy', ['auto']);
  await sleep(2_500);

  const statusOf = async (): Promise<{
    kernelViewPageVisible: boolean;
    kernelViewVisible: boolean;
    windowVisible: boolean;
  }> => {
    const reply = await callBridge<{
      kernelViewPageVisible: boolean;
      kernelViewVisible: boolean;
      windowVisible: boolean;
    }>(session, 'shell.getStatus');
    if (!reply.ok) throw new Error(`shell.getStatus 被拒：${JSON.stringify(reply.error)}`);
    return reply.value;
  };

  // 先按平台正常抓一轮（冻结的页面驱动不了抓取）：这一步必须在冻结之前。
  const captured = await callBridge<{ stored: number }>(session, 'jd.capture.run', [{ keyword: '前端', limit: 3 }]);
  if (!captured.ok) throw new Error(`抓取失败：${JSON.stringify(captured.error)}`);
  process.stdout.write(`· 抓取入库 ${String(captured.value.stored)} 条\n`);

  const kernelTarget = (await listTargets(cdpPort)).find(
    (target) => target.type === 'page' && target.url.includes(`127.0.0.1:${String(fixturePort)}`),
  );
  if (kernelTarget?.webSocketDebuggerUrl === undefined) throw new Error('没找到内核视图 target（会话没打开？）');
  const kernel = await attachRaw(kernelTarget.webSocketDebuggerUrl);

  // ①（先做）可见态的正向对照：同一份请求在页面可见时必须真发得出去——
  // 否则这道闸就成了永久拒绝。放在冻结之前做，避免依赖「解冻后窗口还得被带回前台」这类与本闸无关的环境条件。
  const jobsReply = await callBridge<{ rows: { jobId: string; title: string }[] }>(session, 'jd.store.list', [10]);
  if (!jobsReply.ok || jobsReply.value.rows[0] === undefined) throw new Error('库里没有岗位：先抓一轮');
  // 真附件：种一份虚构样例再导 PDF（闸在附件校验之后、页面动作之前，所以文件必须是真的）。
  await callBridge(session, 'resume.export.seedDemo', ['base']);
  const exported = await callBridge<{ path: string }>(session, 'resume.export.toPdf', ['resume-demo']);
  if (!exported.ok) throw new Error(`样例 PDF 导出失败：${JSON.stringify(exported.error)}`);

  const visibleJob = jobsReply.value.rows[0];
  const visibleRequest = {
    platform: 'boss',
    jobId: visibleJob.jobId,
    title: visibleJob.title,
    company: '示例科技',
    filePath: exported.value.path,
  };
  const delivered = await callBridge<{ committed: boolean; ledgerId: number | null }>(
    session,
    'outbound.deliver.perform',
    [visibleRequest],
  );
  check(
    delivered.ok === true && delivered.value.committed === true && delivered.value.ledgerId !== null,
    `可见态同一份请求发得出去：${delivered.ok ? `committed=${String(delivered.value.committed)} · ledgerId=${String(delivered.value.ledgerId)}` : `code=${String(delivered.error.code)}`}`,
  );
  const trackingAtStart = await callBridge<{ jobId: string; state: string | null }[]>(
    session,
    'journey.tracking.list',
    [],
  );
  check(
    trackingAtStart.ok &&
      trackingAtStart.value.some((row) => row.jobId === visibleJob.jobId && row.state === 'delivered'),
    `投递后追踪到位：${JSON.stringify(trackingAtStart.ok ? trackingAtStart.value.map((row) => `${row.jobId}=${String(row.state)}`) : trackingAtStart)}`,
  );

  const beforeFreeze = await statusOf();
  const visibleBefore = await kernel.evaluate<string>('document.visibilityState');
  check(
    visibleBefore === 'visible' && beforeFreeze.kernelViewPageVisible === true,
    `冻结前页面可见：document.visibilityState=${visibleBefore} · kernelViewPageVisible=${String(beforeFreeze.kernelViewPageVisible)}`,
  );

  await kernel.send('Page.setWebLifecycleState', { state: 'frozen' });
  await sleep(800);
  const frozenState = await kernel.evaluate<string>('document.visibilityState');
  const afterFreeze = await statusOf();
  // 「先断言再调用」：这一行不成立就不该发起投递（对应 QA 那轮 skip 的纪律）。
  check(frozenState === 'hidden', `冻结后页面层断言：document.visibilityState=${frozenState}（必须是 hidden）`);
  check(
    afterFreeze.kernelViewPageVisible === false &&
      afterFreeze.kernelViewVisible === true &&
      afterFreeze.windowVisible === true,
    `冻结后 getStatus：windowVisible=${String(afterFreeze.windowVisible)} kernelViewVisible=${String(afterFreeze.kernelViewVisible)} kernelViewPageVisible=${String(afterFreeze.kernelViewPageVisible)}`,
  );

  // 冻结态那一发换**另一条岗位**：同一条会命中四元组去重，验不到这道闸。
  const frozenJob = jobsReply.value.rows[1] ?? visibleJob;
  const request = { ...visibleRequest, jobId: frozenJob.jobId, title: frozenJob.title };

  const attemptsBefore = await callBridge<unknown[]>(session, 'usage.ledger.recentAttempts', [50]);
  const attemptsBeforeCount = attemptsBefore.ok ? attemptsBefore.value.length : -1;
  const ledgerBefore = await callBridge<{ recent: unknown[] }>(session, 'usage.ledger.summary', [50]);
  const ledgerBeforeCount = ledgerBefore.ok ? ledgerBefore.value.recent.length : -1;

  const refused = await callBridge(session, 'outbound.deliver.perform', [request]);
  const attemptsAfter = await callBridge<unknown[]>(session, 'usage.ledger.recentAttempts', [50]);
  const attemptsAfterCount = attemptsAfter.ok ? attemptsAfter.value.length : -1;
  check(
    refused.ok === false && refused.error.code === 'OUTBOUND_WINDOW_NOT_VISIBLE',
    `页面 hidden 时投递被拒：code=${refused.ok ? '（成功，不该）' : String(refused.error.code)} · details=${JSON.stringify(
      refused.ok ? null : refused.error.details,
    )}`,
  );
  check(
    attemptsBeforeCount === attemptsAfterCount,
    `隐藏态零 attempt：attempts ${String(attemptsBeforeCount)} → ${String(attemptsAfterCount)}`,
  );
  const ledgerAfterRefusal = await callBridge<{ recent: unknown[] }>(session, 'usage.ledger.summary', [50]);
  check(
    ledgerBeforeCount === (ledgerAfterRefusal.ok ? ledgerAfterRefusal.value.recent.length : -1),
    `隐藏态零账本：账本 ${String(ledgerBeforeCount)} → ${String(
      ledgerAfterRefusal.ok ? ledgerAfterRefusal.value.recent.length : -1,
    )}`,
  );

  kernel.close();
  session.close?.();
  app.kill('SIGTERM');
  process.stdout.write(
    `\n窗口闸结论：${failures.length === 0 ? `通过（${String(checks)} 条判据）` : `失败（${String(failures.length)}/${String(checks)} 条不成立）`}\n`,
  );
  if (failures.length > 0) process.exitCode = 1;
};

void main().catch((error: unknown) => {
  process.stderr.write(`窗口闸脚本失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
