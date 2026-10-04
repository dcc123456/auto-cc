/**
 * 发布冒烟：对 **dist 产物**跑一遍最小链路（启动 → 进对话 → 跑占位工作流 → 退出），spec 5.9-07。
 *
 * 为什么必须存在：1.7 与 5.9-a 的自包含证据都停在"能起、能进主界面"，而发布真正要回答的是
 * "起来之后那条主链路在**装机载荷**里还通不通"——dev 里通不代表 `app.asar` 里通（外置依赖搬运、
 * CSP、内核路径都只在产物侧才生效）。这条脚本就是那个缺口，并且它**非零退出即阻断发布**：
 * 任何一步不过都不许"看着差不多"地放行。
 *
 * 三条纪律（都有代码保证，不是注释承诺）：
 * - **不碰真实平台**（§7.2）：占位工作流取内置 `boss-basic`，其节点目标写死在本机 fixture
 *   （`http://127.0.0.1:10233/…`），fixture 站点由本脚本**在自己进程里**起，脚本一退出就一起没了。
 * - **不抢用户正在用的 app**（§9）：单实例锁按 userData 目录算，所以每轮用一份**全新的**
 *   `tmp/smoke-dist/userdata-<时间戳>`，测完留着不删（删了就像"每次都是首启动"，掩盖真实状态）。
 * - **只用白名单口**：业务动作全部经 `window.autoCC.*`（preload 按 `RENDERER_ALLOWLIST` 生成），
 *   不 import 主进程模块、不开第二条通道。
 *
 * 用法：`pnpm smoke:dist`（可加 `--exe <路径>` `--cdp-port` `--fixture-port` `--plan` `--out`）。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { CdpSession, listTargets } from '../packages/testing/src/cdp.js';

const repoRoot = path.resolve(import.meta.dirname, '..');

/**
 * 读取 `--key value` 形态的命令行参数。
 * @param name 参数名（不含前导 `--`）
 * @param fallback 缺省值——全部缺省都指向本机、可复现的读数，不需要用户手敲
 * @returns 参数字符串
 */
const flag = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
};

const cdpPort = Number(flag('cdp-port', '10266'));
const fixturePort = Number(flag('fixture-port', '10233'));
const planId = flag('plan', 'boss-basic');
const runTimeoutMs = Number(flag('run-timeout-ms', '120000'));
const stamp = new Date().toISOString().replaceAll(':', '-').slice(0, 19);
const smokeDir = path.join(repoRoot, 'tmp', 'smoke-dist');
const userDataDir = path.join(smokeDir, `userdata-${stamp}`);
const logFile = path.resolve(repoRoot, flag('out', path.join('tmp', 'smoke-dist', `smoke-${stamp}.txt`)));

/**
 * 本机平台对应的解包产物路径（`electron-builder --dir` 那一支）。
 * @returns 可执行文件的绝对路径
 */
const artifactForCurrentPlatform = (): string => {
  const overrideIndex = process.argv.indexOf('--exe');
  const override = overrideIndex >= 0 ? process.argv[overrideIndex + 1] : undefined;
  if (override) return path.resolve(repoRoot, override);
  if (process.platform === 'win32') return path.join(repoRoot, 'dist', 'win-unpacked', 'auto-cc.exe');
  if (process.platform === 'darwin')
    return path.join(repoRoot, 'dist', 'mac', 'auto-cc.app', 'Contents', 'MacOS', 'auto-cc');
  return path.join(repoRoot, 'dist', 'linux-unpacked', 'auto-cc');
};

const lines: string[] = [];

/**
 * 中途抛错也必须回收的句柄——冒烟失败不能把装机产物留在后台跑，
 * 也不能把 CDP 会话挂在已退出的进程上（实测：不回收时 tsx 退出会撞 `UV_HANDLE_CLOSING` 断言）。
 */
let runningApp: ChildProcessWithoutNullStreams | undefined;
let runningBridge: CdpSession | undefined;

/** 产物进程自己报的退出码；`undefined` = 还没退出（冒烟靠它判"干净退出"，不等 CDP 回包）。 */
let appExitCode: number | null | undefined;

/**
 * 同时打到 stdout 与日志缓冲——冒烟的产物就是这份可归档的文字日志（spec 5.9-07 的"冒烟通过日志"）。
 * @param text 一行读数
 */
const say = (text: string): void => {
  lines.push(text);
  console.log(text);
};

/**
 * 断言并记录一条判据读数；不过就抛，让整条冒烟非零退出。
 * @param label 读数说明（进日志）
 * @param passed 判定结果
 * @param detail 现场值原话，失败时要能看出差在哪
 */
const requireStep = (label: string, passed: boolean, detail: string): void => {
  say(`${passed ? 'PASS' : 'FAIL'} · ${label} —— ${detail}`);
  if (!passed) throw new Error(`冒烟失败：${label}`);
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 轮询等一个选择器在页面上出现。
 *
 * 装机产物上没有 HMR，界面从"隐私首屏"切回主界面是一次 React 状态迁移，
 * 点完确认立刻查元素会查到"还没有"（实测：`未找到可点击元素：[data-view="chat"]`）。
 * @param bridge CDP 会话
 * @param selector CSS 选择器
 * @param timeoutMs 上限
 * @returns 是否出现过
 */
async function waitForSelector(bridge: CdpSession, selector: string, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const present = await bridge.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`);
    if (present) return true;
    await sleep(250);
  }
  return false;
}

/** IPC 回包形状（`BridgeReply`）。 */
type BridgeReply<T> = { ok: true; value: T } | { ok: false; error: { message?: string; code?: string } };

/** 工作流运行读数（与 `WorkflowRunView` 对齐，脚本只取需要判定的字段）。 */
interface RunView {
  runId: string;
  status: 'idle' | 'running' | 'paused' | 'failed' | 'done';
  stepIndex: number;
  requiresHuman: boolean | null;
  steps?: { id?: string; status?: string }[];
}

/**
 * 在页面里调一条白名单口。
 *
 * 命名空间按**第一个点**切（与 `packages/preload/src/index.ts` 同源规则），所以
 * `workflow.runner.start` 是 `autoCC.workflow['runner.start']`——写成 `autoCC.workflow.runner.start`
 * 会拿到 undefined，那是这条切法最容易踩的地方。
 * @param bridge 会话
 * @param apiPath 白名单里的完整 path
 * @param args 实参，序列化后进 invoke
 * @returns 回包里的 `value`
 * @throws 回包 `ok:false` 时抛出错误原话——冒烟不粉饰被拒的原因
 */
async function callBridge<T>(bridge: CdpSession, apiPath: string, args: unknown[] = []): Promise<T> {
  const dot = apiPath.indexOf('.');
  const namespace = apiPath.slice(0, dot);
  const method = apiPath.slice(dot + 1);
  const reply = await bridge.evaluate<BridgeReply<T>>(
    `(window.autoCC[${JSON.stringify(namespace)}][${JSON.stringify(method)}](...${JSON.stringify(args)}))`,
  );
  if (reply?.ok !== true) {
    throw new Error(`${apiPath} 被拒：${JSON.stringify(reply?.error ?? null)}`);
  }
  return reply.value;
}

/**
 * 等 fixture 站点真的在听。
 * @param port 端口
 */
async function waitForFixture(port: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/boss`);
      if (response.ok) return;
    } catch {
      // 服务还在起，继续等；超时由 deadline 判。
    }
    await sleep(200);
  }
  throw new Error(`fixture 站点没起来（端口 ${String(port)}）`);
}

/**
 * 等产物的渲染层 target 出现在 CDP 上。
 * @param port CDP 端口
 * @param timeoutMs 上限——装机首启动比 dev 慢（解压 asar + 48 插件挂载）
 */
async function waitForPageTarget(port: number, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await listTargets(port).catch(() => []);
    if (targets.some((target) => target.type === 'page' && target.url.includes('app.asar'))) return;
    await sleep(300);
  }
  throw new Error(`CDP ${String(port)} 上没等到产物页面（app.asar）`);
}

/**
 * 端口上是否已经有一个 fixture 站点在听（认它自己的 JSON 接口，不认"能连上"）。
 *
 * 为什么要这一条：占位工作流的 `startUrl` 写死在 `http://127.0.0.1:10233/boss`
 * （`packages/platform-boss/src/knowledge/boss.json`），冒烟不能换个端口就跑，
 * 而 10233 上很可能已经有上一轮 dev/harness 起的那台在听——直接 `import` 会得到
 * `EADDRINUSE` 未处理异常（实测），脚本连一步判据都留不下。
 * @returns 已有一个能回 `/api/jobs` JSON 的站点时为 true（此时复用，不再起第二台）
 */
async function fixtureAlreadyUp(): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(fixturePort)}/api/jobs?page=1&query=%E5%B2%97`);
    if (!response.ok) return false;
    const contentType = response.headers.get('content-type') ?? '';
    return contentType.includes('json');
  } catch {
    return false;
  }
}

/**
 * 主流程：六步串起来，任何一步抛错都让进程非零退出。
 */
async function main(): Promise<void> {
  mkdirSync(smokeDir, { recursive: true });
  const exe = artifactForCurrentPlatform();
  say(`auto-cc 发布冒烟 · ${new Date().toISOString()}`);
  say(`平台=${process.platform} · 产物=${exe} · userData=${userDataDir} · CDP=${String(cdpPort)} · 计划=${planId}`);

  // ① 产物与随包文件：5.9-c 的许可记账、5.9-b 的 app-update.yml、5.9-d 的首屏都要求"真的在安装包里"。
  requireStep('冒烟 1/6 产物存在', existsSync(exe), exe);
  const resourcesDir =
    process.platform === 'darwin'
      ? path.join(path.dirname(exe), '..', 'Resources')
      : path.join(path.dirname(exe), 'resources');
  const bundled = ['app-update.yml', 'LICENSES.md', 'THIRD-PARTY-NOTICES.txt'].map(
    (file) => `${file}:${existsSync(path.join(resourcesDir, file)) ? '在' : '缺'}`,
  );
  requireStep(
    '冒烟 1/6 随包文件齐',
    bundled.every((entry) => entry.endsWith('在')),
    `resources=${resourcesDir} → ${bundled.join(' / ')}`,
  );

  // ② fixture 站点：优先复用已在听的那台；没有就在**本进程里**起（`fixture-server.ts` 模块顶层就 listen），
  //    脚本一退出它跟着没，不会留下占着 10233 的孤儿进程。
  if (await fixtureAlreadyUp()) {
    say(
      `PASS · 冒烟 2/6 fixture 站点可用 —— 复用已在听的 http://127.0.0.1:${String(fixturePort)}（未新起，§7.2 零出网）`,
    );
  } else {
    process.env.FIXTURE_PORT = String(fixturePort);
    await import('./fixture-server.js');
    await waitForFixture(fixturePort);
    say(`PASS · 冒烟 2/6 fixture 站点可用 —— 本轮新起 http://127.0.0.1:${String(fixturePort)}/boss（零出网，§7.2）`);
  }

  // ③ 启动产物：全新 userData（不抢用户正在装的那份，§9）+ CDP 端口。
  const app = spawn(
    exe,
    [
      `--remote-debugging-port=${String(cdpPort)}`,
      `--user-data-dir=${userDataDir}`,
      '--disable-features=CalculateNativeWinOcclusion',
    ],
    {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  runningApp = app;
  app.stdout.on('data', (chunk: Buffer) => process.stdout.write(`[app] ${chunk.toString()}`));
  app.stderr.on('data', (chunk: Buffer) => process.stderr.write(`[app!] ${chunk.toString()}`));
  app.on('exit', (code, signal) => {
    appExitCode = code ?? 0;
    say(`· 产物进程退出 code=${String(code)} signal=${String(signal)}`);
  });
  await waitForPageTarget(cdpPort);
  const bridge = await CdpSession.attach(cdpPort, 'app.asar');
  runningBridge = bridge;
  requireStep('冒烟 3/6 产物已启动并进渲染层', true, `target 里出现 app.asar 页面，CDP=${String(cdpPort)}`);

  // ④ 首屏 → 进对话：隐私声明那一屏在产物里真的会出现（5.9-d 的产物侧一眼就在这一步补上）。
  const sawPrivacy = await waitForSelector(bridge, '[data-testid="privacy-notice"]', 10_000);
  if (sawPrivacy) await bridge.click({ selector: '[data-action="privacy-acknowledge"]' });
  const tabsReady = await waitForSelector(bridge, '[data-view="chat"]');
  requireStep(
    '冒烟 4/6 首屏与主界面都在',
    tabsReady,
    `隐私首屏出现过=${String(sawPrivacy)} · 视图切换口出现=${String(tabsReady)}`,
  );
  await bridge.click({ selector: '[data-view="chat"]' });
  const chatVisible = await waitForSelector(bridge, '[data-testid="chat-panel"] [data-testid="chat-input"]');
  requireStep('冒烟 4/6 进对话', chatVisible, `对话输入框可见=${String(chatVisible)}`);

  // ⑤ 跑占位工作流：内置 `boss-basic`（3 节点，全部指向本机 fixture，无外发动作）。
  const plans = await callBridge<{ id: string; name: string; nodeCount: number }[]>(bridge, 'workflow.runner.plans');
  requireStep(
    '冒烟 5/6 内置计划在产物里在册',
    plans.some((plan) => plan.id === planId),
    plans.map((plan) => `${plan.id}(${String(plan.nodeCount)})`).join(', '),
  );
  await callBridge(bridge, 'sessions.grantConsent', ['boss']);
  await callBridge(bridge, 'sessions.open', ['boss']);
  const started = await callBridge<RunView>(bridge, 'workflow.runner.start', [planId]);
  say(`· 起跑 runId=${started.runId} status=${started.status}`);
  const deadline = Date.now() + runTimeoutMs;
  let view = started;
  while (Date.now() < deadline && (view.status === 'running' || view.status === 'idle')) {
    await sleep(500);
    view = await callBridge<RunView>(bridge, 'workflow.runner.current');
  }
  const stepReading = (view.steps ?? [])
    .map((step) => `${String(step.id ?? '?')}=${String(step.status ?? '?')}`)
    .join(' / ');
  requireStep(
    '冒烟 5/6 占位工作流跑通',
    view.status === 'done' && !view.requiresHuman,
    `status=${view.status} requiresHuman=${String(view.requiresHuman)} 节点=${stepReading || '无步骤读数'}`,
  );

  // ⑥ 干净退出：走 CDP 的 `Browser.close`（不是 kill），产物进程自己收摊。
  //
  // 判退出**只能看进程事件**：`Browser.close` 的回包在浏览器开始收摊的一瞬间就没了对象，
  // `await` 它会留下一个永不 settle 的 promise（实测：tsx 因此报 `Detected unsettled top-level await`
  // 并以退出码 13 结束，冒烟明明全过却像失败了）。所以这里发完就不等回包，改轮询 exit 事件。
  void bridge.send('Browser.close').catch(() => undefined);
  const exitDeadline = Date.now() + 15_000;
  while (appExitCode === undefined && Date.now() < exitDeadline) await sleep(200);
  const exited = appExitCode !== undefined;
  if (!exited) app.kill();
  try {
    bridge.close();
  } catch {
    /* 浏览器先走了，会话本来就断了 */
  }
  requireStep(
    '冒烟 6/6 干净退出',
    exited,
    exited ? `Browser.close 后进程自行退出 code=${String(appExitCode)}` : '15s 内没退出，已 kill',
  );

  const asarHeader = path.join(path.dirname(exe), 'resources', 'app.asar');
  say(
    `· 附读：app.asar ${existsSync(asarHeader) ? `${String(Math.round(readFileSync(asarHeader).byteLength / 1024 / 1024))} MiB` : '不在'}`,
  );
  say('冒烟结论：六步全过，产物可发。');
}

try {
  await main();
} catch (error) {
  lines.push(`冒烟结论：失败 —— ${error instanceof Error ? error.message : String(error)}`);
  console.error(lines[lines.length - 1]);
  // 失败路径同样要收摊：留着装机产物在后台跑，下一次冒烟会被自己的残留干扰（§9 也不允许去动用户的实例）。
  try {
    runningBridge?.close();
  } catch {
    /* 会话本来就没建成 */
  }
  if (runningApp && runningApp.exitCode === null) runningApp.kill();
  writeFileSync(logFile, `${lines.join('\n')}\n`, 'utf8');
  process.exit(1);
}
writeFileSync(logFile, `${lines.join('\n')}\n`, 'utf8');
