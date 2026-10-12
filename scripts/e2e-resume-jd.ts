/**
 * 端到端自测：本地简历 PDF → 知识库实体 → 搜一个前端 JD → 按这份 JD 定制简历并导出 PDF。
 *
 * 为什么要有这条脚本：四段能力各自都有单测与活体读数（4.1 导入、4.2 建库、2.3 抓取、4.5 定制），
 * 但**把它们串成人的主流程**这件事从没在一次运行里整体跑通过——单测各管一段，跨段的键（`docId`、
 * `jobId`、`receiptId`）传错、缺前置（未签字 / 会话未开 / 适配器还指着真站点）都只在串起来时才暴露。
 *
 * 三条纪律（都有代码保证）：
 * - **不碰真实平台**（AGENTS.md §7.2）：抓取之前先把 `platform-boss` 切到仿站知识包（本机 10233），
 *   配置只写内存、重启即失（§9 的 5.3-b），不动任何落盘载荷。
 * - **不抢用户正在用的 app**（§9）：每轮用一份**独立 userData**（默认从开发实例 rsync 来，带上已配置的
 *   模型提供商，好让 4.5 的模型通道真的跑；没有源目录就退成空目录，此时生成通道走 4.5-09 的仅重排保守版，
 *   脚本会把走的是哪条通道如实记下来）。副本里必须删掉 `Singleton*` 才拿得到锁。
 * - **只用白名单口**：业务动作全部经 `window.autoCC.*`，不 import 主进程模块。
 *
 * 慢调用（抓取要滚读、模型通道要等真端点）一律用「页面里发起 → 轮询取回」而不是让 CDP 请求挂在飞行中，
 * 避免长 await 撞上位超时（§9 的 8.3-01 那条 `unsettled top-level await` 同一形状）。
 *
 * 用法：`pnpm e2e:resume-jd`（可加 `--pdf` `--keyword` `--cdp-port` `--fixture-port` `--userdata-src`
 * `--userdata-dest` `--out` `--renderer dist|vite` `--renderer-url`）。默认 `dist`：自己 build 一份渲染层产物
 * 并起一个专属 Electron 实例，不依赖也不共享别人那套 dev 会话的 HMR（理由见 `rendererMode` 的注释）。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { CdpSession, listTargets } from '../packages/testing/src/cdp.js';

const repoRoot = path.resolve(import.meta.dirname, '..');

/**
 * 读取 `--key value` 形态的命令行参数。
 * @param name 参数名（不含前导 `--`）
 * @param fallback 缺省值——全部指向本机、可复现的读数
 * @returns 参数字符串
 */
const flag = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
};

/**
 * 读取一个**只在显式给出时才生效**的参数（用于运行时覆盖装配配置做搜索，不给出就走清单里的发货值）。
 * @param name 参数名（不含前导 `--`）
 * @returns 数字值；未给出时 undefined
 */
const overrideFlag = (name: string): number | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  const raw = index >= 0 ? process.argv[index + 1] : undefined;
  return raw === undefined ? undefined : Number(raw);
};

/** 测试简历：用户点名的那一份真实 PDF（不是仓库里的 fixture 语料）。 */
const pdfPath = path.resolve(
  flag(
    'pdf',
    path.join(homedir(), 'deepseek-harness-workspece', 'office-copilot', 'tmp', '丁长长-高级前端开发2026.pdf'),
  ),
);
const cdpPort = Number(flag('cdp-port', '10277'));
const fixturePort = Number(flag('fixture-port', '10233'));
const rendererUrl = flag('renderer-url', 'http://127.0.0.1:5173');
const keyword = flag('keyword', '前端');
const captureTarget = Number(flag('jd-limit', '5'));
const userdataSrc = path.resolve(repoRoot, flag('userdata-src', path.join('tmp', 'v6-userdata')));
const stamp = new Date().toISOString().replaceAll(':', '-').slice(0, 19);
const e2eDir = path.join(repoRoot, 'tmp', 'e2e-resume');
const userdataDest = path.resolve(repoRoot, flag('userdata-dest', path.join(e2eDir, `userdata-${stamp}`)));
const logFile = path.resolve(repoRoot, flag('out', path.join(e2eDir, `e2e-${stamp}.txt`)));
/**
 * 渲染层来源：`dist` = 用 `packages/renderer/dist` 那份**构建产物**（默认），`vite` = 连一台已在听的 dev 服务器。
 *
 * 换成 dist 是实测逼出来的（2026-10-12 第 16 轮）：共享工作树里另一套 dev 会话正在改渲染层，
 * vite 每热更一次就把页面 reload 掉，而本脚本的生成通道是**一条六分钟的在飞调用**、读数挂在
 * `window.__e2e` 上——reload 一次丢一次读数，脚本按"丢了就重发"又白等六分钟，两轮下来整条链跑不完。
 * dist 模式没有 HMR 通道，页面不会被人改动带跑；代价是产物可能落后于源码，所以起会话前显式 build 一次。
 */
const rendererMode = flag('renderer', 'dist');
/**
 * 生成通道的等待上限：一次真端点的产出实测 356～370s，而服务内部对"连接断了"还会重发一次
 * （`MODEL_LEG_NETWORK_RETRIES`，§9 的 2026-10-12 那条），最坏是两发 `modelTimeoutMs`（420s × 2）
 * 再加本地那几段，所以这一格必须按**分钟**给，且要高于服务侧自己的两层上限。
 */
const GENERATE_TIMEOUT_MS = Number(flag('generate-timeout-ms', '900000'));
/**
 * 三个模型通道的运行时覆盖（只在显式给 `--…` 时才 patch 配置）。
 *
 * **不给就是发货值**：这条链路的判据是"按 app 真正带着的配置能不能生成一份适合 JD 的简历"，
 * 脚本自己抬参数会把"发货即坏"这件事遮掉（本轮实测过：清单里 pin 的 `modelMaxTokens` 512 让
 * 每一次真实产出都以截断收场，界面只显示保守回落，看起来像功能没做）。
 * 覆盖只写内存、重启即失（§9 的 5.3-b），用于搜索"该把发货值定在哪一档"。
 */
const MODEL_TIMEOUT_OVERRIDE = overrideFlag('model-timeout-ms');
const MODEL_MAX_TOKENS_OVERRIDE = overrideFlag('model-max-tokens');
const MAX_REWRITE_CHARS_OVERRIDE = overrideFlag('max-rewrite-chars');
const CAPTURE_TIMEOUT_MS = Number(flag('capture-timeout-ms', '180000'));

const lines: string[] = [];
let runningApp: ChildProcessWithoutNullStreams | undefined;
let runningBridge: CdpSession | undefined;
let appExitCode: number | null | undefined;

/**
 * 同时打到 stdout 与日志缓冲——这条脚本的产物就是这份可归档的文字读数。
 * @param text 一行读数
 */
const say = (text: string): void => {
  lines.push(text);
  console.log(text);
};

/**
 * 记录一条判据读数；不过就抛，让整条链路非零退出。
 * @param label 判据说明
 * @param passed 判定结果
 * @param detail 现场值原话
 */
const requireStep = (label: string, passed: boolean, detail: string): void => {
  say(`${passed ? 'PASS' : 'FAIL'} · ${label} —— ${detail}`);
  if (!passed) throw new Error(`链路失败：${label}`);
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** IPC 回包信封（`BridgeReply`）：渲染层不抛，判据必须现读 `ok`（§9 的 2.1-12）。 */
type BridgeReply<T> = { ok: true; value: T } | { ok: false; error?: { message?: string; code?: string } };

/** 挂在页面上的读数槽形状：`lost` 是页面被 reload 之后的形态（此时那一发还在主进程里飞）。 */
type SlotView<T> = { state: string; reply?: BridgeReply<T>; error?: string };

/**
 * 在页面里调一条白名单口，用「发起 → 轮询」而不是长 await。
 *
 * 命名空间按**第一个点**切（`packages/preload/src/index.ts` 的 `buildNamespaces`），所以
 * `resume.generate.run` 是 `autoCC.resume['generate.run']`；写成点号连三级会拿到 undefined。
 * @param bridge CDP 会话
 * @param apiPath 白名单里的完整 path
 * @param args 实参数组
 * @param timeoutMs 等待上限（慢调用按分钟给）
 * @returns 回包里的 `value`
 * @throws 回包 `ok:false` 时抛出被拒的原话；超时抛出仍在飞行的读数
 *
 * 读数挂在 `window.__e2e` 上，而**渲染层被人 reload 一次它就整块没了**（本机实测：与另一套 dev 会话并存时，
 * 那边改渲染层源码触发 vite 全量 reload，run 11 的生成通道因此丢在半路）。这里按"丢了就重发"处理，
 * 并把重发次数如实打出来——写口重发会多落一行记录，那是共享工作树上的环境代价，不是产品行为。
 */
async function callBridge<T>(
  bridge: CdpSession,
  apiPath: string,
  args: unknown[] = [],
  timeoutMs = 60_000,
): Promise<T> {
  const dot = apiPath.indexOf('.');
  const namespace = apiPath.slice(0, dot);
  const method = apiPath.slice(dot + 1);
  const slot = `s${String(Math.floor(Math.random() * 1e9))}`;
  const kick = async (): Promise<void> => {
    const kicked = await bridge.evaluate(
      `(() => {
        const w = window;
        w.__e2e = w.__e2e ?? {};
        w.__e2e[${JSON.stringify(slot)}] = { state: 'pending' };
        Promise.resolve(window.autoCC[${JSON.stringify(namespace)}][${JSON.stringify(method)}](...${JSON.stringify(args)}))
          .then((reply) => { w.__e2e[${JSON.stringify(slot)}] = { state: 'done', reply }; })
          .catch((error) => { w.__e2e[${JSON.stringify(slot)}] = { state: 'thrown', error: String(error && error.message ? error.message : error) }; });
        return 'kicked';
      })()`,
    );
    if (kicked !== 'kicked') throw new Error(`${apiPath} 发起失败`);
  };
  await kick();
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  /** 页面被别人 reload 之后重发动的次数（见函数头的说明）。 */
  let reKicks = 0;
  /** 一条真端点的调用要用**秒**进读数：这条链的发货超时值就是照这些数定的（§9 的 7.1-d）。 */
  const elapsedSay = (note: string): void => {
    const seconds = Math.round((Date.now() - startedAt) / 100) / 10;
    if (seconds >= 5) say(`· ${apiPath} 用时 ${String(seconds)}s ${note}`);
  };
  for (;;) {
    // 求值本身也可能因页面正在 reload 而抛（run 11 实测：`Cannot read properties of undefined
    // (reading 's…')`——那是 `window.__e2e` 整个没了），所以这里连 evaluate 一起兜住，当成"读数丢了"。
    const slotView = await bridge
      .evaluate<SlotView<T>>(`window.__e2e?.[${JSON.stringify(slot)}] ?? { state: 'lost' }`)
      .catch((): SlotView<T> => ({ state: 'lost' }));
    if (slotView?.state === 'done') {
      const reply = slotView.reply;
      if (reply?.ok !== true) {
        elapsedSay('（被拒）');
        throw new Error(`${apiPath} 被拒：${JSON.stringify(reply?.error ?? null)}`);
      }
      elapsedSay('');
      return reply.value;
    }
    if (slotView?.state === 'thrown') {
      elapsedSay('（抛错）');
      throw new Error(`${apiPath} 抛错：${String(slotView.error)}`);
    }
    if (slotView?.state === 'lost') {
      if (reKicks >= 3) throw new Error(`${apiPath} 所在页面被 reload 三次，飞行中的调用拿不回来了`);
      reKicks += 1;
      say(`· ${apiPath} 的读数随页面 reload 丢了，重发第 ${String(reKicks)} 次（这一侧的写口会多落一行记录）`);
      await waitForBridge(bridge, 30_000);
      await kick();
      continue;
    }
    if (Date.now() > deadline) {
      elapsedSay('（等到上限仍未回）');
      throw new Error(`${apiPath} 等待超过 ${String(timeoutMs)}ms`);
    }
    await sleep(500);
  }
}

/** 导入回执（镜像 `ImportReceiptView`，只取判据要的字段）。 */
interface ImportReceipt {
  status: 'imported' | 'scanned';
  docId: string;
  sourceHash: string;
  format: string;
  isNew: boolean;
  textLength: number;
  sections: { kind: string; title: string; entries: number }[];
  issues: { code?: string; message?: string }[];
}

/** 知识库实体行（镜像 `KbEntityRowView`）。 */
interface KbEntityRow {
  entityId: string;
  kind: string;
  sourceDocId: string;
  parentId: string | null;
}

/** 一次同步的读数（镜像 `KbSyncRowResult`）。 */
interface KbSyncResult {
  docId: string;
  created: number;
  updated: number;
  removed: number;
}

/** 抓取轮结局（镜像 `CaptureRunView`）。 */
interface CaptureRun {
  platform: string;
  keyword: string;
  rounds: number;
  containers: number;
  stored: number;
  captured: { jobId: string; title: string }[];
  skipped: { title: string; reason: string }[];
  stoppedBy: string;
  total: number;
  ledgerRowsBefore: number;
  ledgerRowsAfter: number;
}

/** 岗位行（镜像 `JobRowView`）。 */
interface JobRow {
  jobId: string;
  platform: string;
  title: string;
  company: string;
  salaryText: string;
  city: string;
  experience: string;
  education: string;
  description: string;
  requirements: string[];
  sourceUrl: string;
  detailCapturedAt: number | null;
}

/** 缺口报告读数（镜像 `GapReportRowView`，只取判据要的几项）。 */
interface GapReport {
  counts: Record<string, number>;
  rows: unknown[];
  entityCount: number;
  inputChars: number;
  modelStatus: string;
  modelReason: string | null;
}

/** 生成读数（镜像 `GenerationRunRowView`）。 */
interface GenerationRun {
  rewrites: unknown[];
  evidence: unknown[];
  reorderBases: unknown[];
  checks: { ok: boolean; retried: boolean; violations: string[]; violationCount: number };
  receipt: {
    id: string;
    docId: string;
    jdId: string | null;
    model: string | null;
    modelStatus: string;
    modelReason: string | null;
    outcome: string;
    movedSections: number;
    movedEntries: number;
    rewritesApplied: number;
    rewritesDropped: number;
  };
}

/** 接受回执（镜像 `GenerationAcceptRowResult`）。 */
interface GenerationAccept {
  docId: string;
  appliedRewrites: number;
  reorderApplied: boolean;
  movedSections: number;
  movedEntries: number;
  updatedAt: number;
}

/** 导出回执（镜像 `ExportReceiptView`）。 */
interface ExportReceipt {
  docId: string;
  path: string;
  pages: number;
  bytes: number;
  hash: string;
  snapshotId: string;
}

/**
 * 把仿站抓到的一条岗位行拼成 JD 正文（喂给 `kb.gap.report` / `resume.generate.run` 的那一段文本）。
 * @param job 岗位行（必须已经读过详情页，`description` 与 `requirements` 有内容）
 * @returns 多行 JD 正文；专名与薪资都作为文本进去，不在这里做翻译拼接（§5.7 只约束界面文案）
 */
function jdTextOf(job: JobRow): string {
  return [
    `岗位：${job.title}`,
    `公司：${job.company}`,
    `城市：${job.city}`,
    `薪资：${job.salaryText || '面议'}`,
    `经验要求：${job.experience || '未写'}`,
    `学历要求：${job.education || '未写'}`,
    '',
    '职位描述：',
    job.description,
    '',
    '任职要求：',
    ...job.requirements.map((requirement) => `- ${requirement}`),
  ].join('\n');
}

/**
 * 准备这一轮用的 userData 副本：从开发实例 rsync 过来（带上已配置的模型提供商），
 * 并删掉单实例锁句柄，否则第二个实例拿不到锁静默退出 0（§9 的 2.5-d）。
 * @returns 一句来源读数：`rsync 自 <源>` 或 `空目录（源不在）`
 */
async function prepareUserData(): Promise<string> {
  mkdirSync(path.dirname(userdataDest), { recursive: true });
  if (!existsSync(userdataSrc)) {
    mkdirSync(userdataDest, { recursive: true });
    return `空目录（源 ${userdataSrc} 不在，模型通道按缺省缺席）`;
  }
  const rsync = spawn(
    'rsync',
    [
      '-a',
      '--exclude=Cache',
      '--exclude=Code Cache',
      '--exclude=GPUCache',
      '--exclude=blob_storage',
      '--exclude=logs',
      userdataSrc.endsWith(path.sep) ? userdataSrc : `${userdataSrc}${path.sep}`,
      userdataDest,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let rsyncErr = '';
  rsync.stderr.on('data', (chunk: Buffer) => {
    rsyncErr += chunk.toString();
  });
  const code = await new Promise<number | null>((resolve) => rsync.once('close', (exitCode) => resolve(exitCode)));
  if (code !== 0) throw new Error(`rsync userData 副本失败 code=${String(code)}：${rsyncErr.slice(0, 200)}`);
  for (const lockName of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    rmSync(path.join(userdataDest, lockName), { force: true });
  }
  return `rsync 自 ${userdataSrc}（已删 Singleton* 锁句柄）`;
}

/**
 * 等 fixture 站点真的在听；没有在听就在**本进程里**起一台（脚本退出它跟着没）。
 * @param port 端口
 */
async function ensureFixture(port: number): Promise<string> {
  try {
    const response = await fetch(
      `http://127.0.0.1:${String(port)}/api/jobs?page=1&query=${encodeURIComponent(keyword)}`,
    );
    if (response.ok && (response.headers.get('content-type') ?? '').includes('json')) {
      return `复用已在听的 http://127.0.0.1:${String(port)}`;
    }
  } catch {
    // 没在听：下面新起一台。
  }
  process.env.FIXTURE_PORT = String(port);
  await import('./fixture-server.js');
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/boss`);
      if (response.ok) return `本轮新起 http://127.0.0.1:${String(port)}/boss`;
    } catch {
      // 还在起。
    }
    if (Date.now() > deadline) throw new Error(`fixture 站点没起来（端口 ${String(port)}）`);
    await sleep(200);
  }
}

/**
 * 等渲染层 target 出现在 CDP 上。
 * @param port CDP 端口
 * @param urlContains target url 过滤词（开发态是 vite 端口）
 */
async function waitForPageTarget(port: number, urlContains: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const targets = await listTargets(port).catch(() => []);
    if (targets.some((target) => target.type === 'page' && target.url.includes(urlContains))) return;
    await sleep(300);
  }
  throw new Error(`CDP ${String(port)} 上没等到页面（过滤词 ${urlContains}）`);
}

/**
 * 等渲染层的 `window.autoCC` 与主界面都就位。
 *
 * target 出现在 CDP 上远早于 preload 把桥挂上（实测：连上立刻求值会拿到
 * `Cannot read properties of undefined (reading 'resume')`），所以这一步不是可选项。
 * @param bridge CDP 会话
 * @param timeoutMs 上限
 */
async function waitForBridge(bridge: CdpSession, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ready = await bridge
      .evaluate<boolean>('!!(window.autoCC && document.querySelector(\'[data-view="chat"]\'))')
      .catch(() => false);
    if (ready) return;
    if (Date.now() > deadline) throw new Error(`${String(timeoutMs)}ms 内渲染层桥没挂上`);
    await sleep(300);
  }
}

/**
 * 渲染层是否已经有一台 vite 在听（本机回环，只读静态资源）。
 * @param url 渲染层地址
 * @returns 200 即 true；连不上或报错都是 false
 */
async function rendererIsUp(url: string): Promise<boolean> {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

/** Electron 只属于 packages/main 的 devDependencies，因此从该包解析二进制路径（与 `scripts/dev.ts` 同一口径）。 */
function resolveElectron(): string {
  const require = createRequire(path.join(repoRoot, 'packages', 'main', 'package.json'));
  return require('electron') as string;
}

/**
 * 按当前源码构建一次渲染层产物（dist 模式的前置步骤）。
 * @returns 构建成功且产物在盘上为 true；失败为 false（此时沿用已有那份 dist，日志里如实写明"已有的、可能落后于源码"）
 */
async function buildRendererDist(): Promise<boolean> {
  const distIndex = path.join(repoRoot, 'packages', 'renderer', 'dist', 'index.html');
  const build = spawn('npx', ['vite', 'build'], {
    cwd: path.join(repoRoot, 'packages', 'renderer'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  build.stdout.on('data', (chunk: Buffer) => process.stdout.write(`[build] ${chunk.toString()}`));
  build.stderr.on('data', (chunk: Buffer) => process.stdout.write(`[build!] ${chunk.toString()}`));
  const code = await new Promise<number>((resolve) => {
    build.on('exit', (exitCode) => resolve(exitCode ?? 1));
  });
  return code === 0 && existsSync(distIndex);
}

/**
 * 主流程：六段串起来，任何一段抛错都让进程非零退出。
 */
async function main(): Promise<void> {
  mkdirSync(e2eDir, { recursive: true });
  say(`auto-cc 端到端自测（PDF→知识库→JD→定制简历）· ${new Date().toISOString()}`);
  say(
    `简历=${pdfPath} · 关键词=${keyword} · userData=${userdataDest} · CDP=${String(cdpPort)} · 渲染层=${rendererUrl}`,
  );
  requireStep('前置 1 测试简历在盘上', existsSync(pdfPath), pdfPath);
  requireStep(
    '前置 2 渲染层来源不出本机',
    rendererMode === 'dist' || /^https?:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/.test(rendererUrl),
    rendererMode === 'dist' ? 'dist（本机构建产物，无网络地址）' : rendererUrl,
  );

  say(`· fixture：${await ensureFixture(fixturePort)}（§7.2 零出网）`);
  say(`· userData：${await prepareUserData()}`);

  // 拉起**属于本轮的** Electron 实例（CDP 端口与 userData 都是自己的），渲染层有两种来源：
  // - `dist`（缺省）：先按当前源码 `vite build` 一次，再让 Electron `loadFile` 那份产物。
  //   选它是因为共享工作树里另一套 dev 会话每热更一次就把页面 reload 一次，而本脚本的生成通道是一条
  //   **六分钟的在飞调用**、读数挂在 `window.__e2e` 上（第 16 轮实测：连着两次 reload 把读数带走，
  //   按"丢了就重发"各白等六分钟，整条链在这一轮跑不完）。构建产物没有 HMR 通道，页面不会被人改动带跑。
  // - `vite`：复用已在听的渲染层（共享只读静态资源，两个实例各用各的 userData 与 CDP 端口，
  //   §9 的 5.10-13 并存配方），或自己起一套 dev 会话。改主进程射程内的源码时挂别人的 dev
  //   等于把自己的运行期挂在别人的会话上（§9 的 8.3-01）。
  const mainCjs = path.join(repoRoot, 'packages', 'main', 'dist', 'main.cjs');
  const electronArgs = [
    mainCjs,
    `--remote-debugging-port=${String(cdpPort)}`,
    `--user-data-dir=${userdataDest}`,
    '--disable-features=CalculateNativeWinOcclusion',
  ];
  let boot: ChildProcessWithoutNullStreams;
  /** CDP target 的定位串：dist 模式里没有端口可认，只能用构建入口文件名。 */
  let targetPart: string;
  if (rendererMode === 'dist') {
    if (!existsSync(mainCjs)) {
      throw new Error(`dist 模式要有主进程产物：${mainCjs} 不在，先跑一次 pnpm dev（或改用 --renderer vite）`);
    }
    const built = await buildRendererDist();
    if (!built && !existsSync(path.join(repoRoot, 'packages', 'renderer', 'dist', 'index.html'))) {
      throw new Error('渲染层既没构建成功、也没有可用的既有 dist');
    }
    targetPart = 'index.html';
    boot = spawn(resolveElectron(), electronArgs, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      // 刻意不给 ELECTRON_RENDERER_URL：`packages/shell` 里那条判据是"给了就 loadURL，否则 loadFile"。
      env: { ...process.env, ELECTRON_RENDERER_URL: undefined },
    });
    say(`· 会话来源：自己的 Electron 实例 + ${built ? '刚构建的' : '已有的'}渲染层产物（dist，无 HMR）`);
  } else {
    const reuseRenderer = (await rendererIsUp(rendererUrl)) && existsSync(mainCjs);
    targetPart = rendererUrl.includes(':') ? rendererUrl.slice(rendererUrl.lastIndexOf(':') + 1) : '5173';
    boot = reuseRenderer
      ? spawn(resolveElectron(), electronArgs, {
          cwd: repoRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, ELECTRON_RENDERER_URL: rendererUrl },
        })
      : spawn('npx', ['tsx', 'scripts/dev.ts'], {
          cwd: repoRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            AUTO_CC_CDP_PORT: String(cdpPort),
            AUTO_CC_USER_DATA_DIR: userdataDest,
          },
        });
    say(
      `· 会话来源：${reuseRenderer ? `复用已在听的渲染层 ${rendererUrl} + 自己的 Electron 实例` : '本轮自起 dev 会话'}`,
    );
  }
  runningApp = boot;
  boot.stdout.on('data', (chunk: Buffer) => process.stdout.write(`[dev] ${chunk.toString()}`));
  boot.stderr.on('data', (chunk: Buffer) => process.stdout.write(`[dev!] ${chunk.toString()}`));
  boot.on('exit', (code, signal) => {
    appExitCode = code ?? 0;
    say(`· 会话进程退出 code=${String(code)} signal=${String(signal)}`);
  });

  await waitForPageTarget(cdpPort, targetPart);
  const bridge = await CdpSession.attach(cdpPort, targetPart);
  runningBridge = bridge;
  await waitForBridge(bridge);

  // 首屏隐私声明（开发态每次新 userData 都会出现）。同样不用 CDP 派发鼠标（见证据段那条说明）：
  // 这一格遮罩会把真实鼠标事件全接走，而 `node.click()` 直接派给组件监听，遮罩确实消失是可证的。
  const sawPrivacy = await bridge.evaluate<boolean>('!!document.querySelector(\'[data-testid="privacy-notice"]\')');
  if (sawPrivacy) {
    await bridge.evaluate<boolean>(
      `(() => { document.querySelector('[data-action="privacy-acknowledge"]')?.click(); return true; })()`,
    );
    await sleep(500);
  }
  const privacyBlocking = await bridge.evaluate<boolean>(
    '!!document.querySelector(\'[data-testid="privacy-notice"]\')',
  );
  requireStep(
    '启动 渲染层桥与主界面都在',
    !privacyBlocking,
    `桥已挂上 · 隐私首屏出现过=${String(sawPrivacy)} · 判据时遮罩仍在=${String(privacyBlocking)}`,
  );

  // ① 从本地导入 PDF（与界面「导入本地简历」同一只口：文件对话框只给路径，解析在 `resume.parse`）。
  //
  // 先把这一份文件在库里留下的旧记录删掉再导：`fromFile` 的幂等键是来源哈希，同一份 PDF 二次导入
  // 只回读数、不会把人设过的简历重派生一遍（§9 的裁定㉖ 那条删除通道正是为这种情况准备的）。
  // 删除只落在这一轮的 userData **副本**里，不动开发实例那份。
  const provenance = await callBridge<{ docId: string; sourceName: string | null }[]>(
    bridge,
    'resume.parse.provenance',
  );
  const staleDocIds = provenance.filter((row) => row.sourceName === path.basename(pdfPath)).map((row) => row.docId);
  for (const staleDocId of staleDocIds) {
    const removed = await callBridge<unknown>(bridge, 'kb.profile.removeDoc', [staleDocId]);
    say(`· 清掉旧记录 docId=${staleDocId} 回执=${JSON.stringify(removed).slice(0, 160)}`);
  }
  const imported = await callBridge<ImportReceipt>(bridge, 'resume.parse.fromFile', [pdfPath]);
  say(
    `· 导入回执：status=${imported.status} docId=${imported.docId} format=${imported.format} ` +
      `isNew=${String(imported.isNew)} 文本=${String(imported.textLength)} 字`,
  );
  say(
    `· 解析区块：${
      imported.sections.map((section) => `${section.kind}:${String(section.entries)}`).join(' / ') || '无'
    } · 待确认 ${String(imported.issues.length)} 条`,
  );
  requireStep(
    '段 1 本地 PDF 导入并解析出区块',
    imported.status === 'imported' && imported.textLength > 0 && imported.sections.length > 0,
    `status=${imported.status} sections=${String(imported.sections.length)} 个区块`,
  );

  // ② 自动生成实体类（`kb.profile.sync` 从工作副本现派生，幂等）。
  const sync = await callBridge<KbSyncResult>(bridge, 'kb.profile.sync', [imported.docId]);
  const entities = await callBridge<KbEntityRow[]>(bridge, 'kb.profile.list', [{ sourceDocId: imported.docId }]);
  const kindCount = new Map<string, number>();
  for (const entity of entities) kindCount.set(entity.kind, (kindCount.get(entity.kind) ?? 0) + 1);
  const childEntities = entities.filter((entity) => entity.parentId !== null && entity.parentId !== undefined).length;
  say(`· 同步读数：created=${String(sync.created)} updated=${String(sync.updated)} removed=${String(sync.removed)}`);
  say(
    `· 实体清单：共 ${String(entities.length)} 条（${[...kindCount.entries()]
      .map(([kind, count]) => `${kind}=${String(count)}`)
      .join(' ')}）· 挂父子的子实体 ${String(childEntities)} 条`,
  );
  requireStep(
    '段 2 实体类生成（种类≥2 且条数>0）',
    entities.length > 0 && kindCount.size >= 2,
    `${String(entities.length)} 条 / ${String(kindCount.size)} 种`,
  );

  // ③ 搜一个前端岗位 JD：先把适配器切到仿站，再签字、开会话，最后在闸门里跑一轮抓取。
  await callBridge(bridge, 'plugins.saveConfig', ['platform-boss', { pack: 'fixture' }]);
  await callBridge(bridge, 'sessions.grantConsent', ['boss']);
  await callBridge(bridge, 'sessions.open', ['boss']);
  const captured = await callBridge<CaptureRun>(
    bridge,
    'jd.capture.run',
    [{ keyword, limit: captureTarget }],
    CAPTURE_TIMEOUT_MS,
  );
  say(
    `· 抓取读数：${captured.platform}「${captured.keyword}」轮数=${String(captured.rounds)} ` +
      `卡片=${String(captured.containers)} 入库=${String(captured.stored)} 停在=${captured.stoppedBy} ` +
      `跳过=${String(captured.skipped.length)} 账本 ${String(captured.ledgerRowsBefore)}→${String(captured.ledgerRowsAfter)}`,
  );
  const listResult = await callBridge<{ total: number; rows: JobRow[] }>(bridge, 'jd.store.list', [20]);
  const candidates = listResult.rows.filter((row) => row.title.includes(keyword) && row.detailCapturedAt !== null);
  const chosen = candidates.find((row) => row.description.length > 0) ?? candidates[0];
  say(
    `· 库里岗位 ${String(listResult.total)} 行，含「${keyword}」且有详情 ${String(candidates.length)} 行；` +
      `选中 ${String(chosen?.jobId ?? '无')}「${String(chosen?.title ?? '')}」正文 ${String(chosen?.description.length ?? 0)} 字 · 要求 ${String(chosen?.requirements.length ?? 0)} 条`,
  );
  if (chosen === undefined) throw new Error('抓取回来但没有一条带详情的岗位，JD 通道断了');
  const jdText = jdTextOf(chosen);
  requireStep(
    '段 3 搜到一个前端 JD 并填出正文',
    captured.stored > 0 && chosen.description.length > 0 && jdText.length > 40,
    `入库 ${String(captured.stored)} 条 · JD 正文 ${String(jdText.length)} 字`,
  );

  // ④ 按这份 JD 定制简历：缺口报告 → 生成 → 接受 → 导出 PDF（前后各导一次比字节）。
  //
  // 模型通道按**发货配置**跑：先把生效配置读进日志（"这一轮是用什么值跑的"必须能被复盘），
  // 只有显式给了 `--model-*` 才 patch 运行时。脚本自己默认抬参数会把"发货即坏"这件事遮掉——
  // 本轮实测过：清单 pin 的 `modelMaxTokens` 512 让每一次真实产出都以截断收场，
  // 而界面只显示保守回落"本次没有采纳任何改写"，看起来像功能没做。
  // 覆盖只写内存、重启即失，且它会重建注入 `llm` 的下游服务（§9 的 5.3-b / 2.5），
  // 所以整段排在 JD 抓取之后：会话视图被那次重建关掉也不影响已经跑完的那几趟。
  const llmConfig = await callBridge<{ values: Record<string, unknown> }>(bridge, 'plugins.readConfig', ['llm']);
  const generateConfig = await callBridge<{ values: Record<string, unknown> }>(bridge, 'plugins.readConfig', [
    'kb-generate',
  ]);
  say(
    `· 生效配置：llm.timeoutMs=${String(llmConfig.values.timeoutMs)} · ` +
      `kb-generate.modelMaxTokens=${String(generateConfig.values.modelMaxTokens)} · ` +
      `modelTimeoutMs=${String(generateConfig.values.modelTimeoutMs)} · ` +
      `maxRewriteChars=${String(generateConfig.values.maxRewriteChars)} · ` +
      `modelTemperature=${String(generateConfig.values.modelTemperature)}`,
  );
  if (MODEL_TIMEOUT_OVERRIDE !== undefined) {
    // 交的是**整份**生效配置加一个键：`saveConfig` 是替换而非合并，漏抄的键会掉回 Schema 缺省。
    await callBridge(bridge, 'plugins.saveConfig', ['llm', { ...llmConfig.values, timeoutMs: MODEL_TIMEOUT_OVERRIDE }]);
    say(
      `· 运行时覆盖：llm.timeoutMs ${String(llmConfig.values.timeoutMs)}→${String(MODEL_TIMEOUT_OVERRIDE)}（不落盘，并重建注入 llm 的下游）`,
    );
  }
  if (MODEL_MAX_TOKENS_OVERRIDE !== undefined || MAX_REWRITE_CHARS_OVERRIDE !== undefined) {
    const patched = { ...generateConfig.values };
    const notes: string[] = [];
    if (MODEL_MAX_TOKENS_OVERRIDE !== undefined) {
      notes.push(`modelMaxTokens ${String(generateConfig.values.modelMaxTokens)}→${String(MODEL_MAX_TOKENS_OVERRIDE)}`);
      patched.modelMaxTokens = MODEL_MAX_TOKENS_OVERRIDE;
    }
    if (MAX_REWRITE_CHARS_OVERRIDE !== undefined) {
      notes.push(
        `maxRewriteChars ${String(generateConfig.values.maxRewriteChars)}→${String(MAX_REWRITE_CHARS_OVERRIDE)}`,
      );
      patched.maxRewriteChars = MAX_REWRITE_CHARS_OVERRIDE;
    }
    await callBridge(bridge, 'plugins.saveConfig', ['kb-generate', patched]);
    say(`· 运行时覆盖：${notes.join(' · ')}（不落盘）`);
  }
  // 缺口报告的模型通道与生成通道走同一个端点，所以它也要按分钟给上限（run 8 实测：默认 60s 在超时抬到
  // 480s 之后必然撞顶——`kb.gap.report` 里的 `modelStatus` 就是要等那句真回复）。
  const gap = await callBridge<GapReport>(
    bridge,
    'kb.gap.report',
    [jdText, { sourceDocId: imported.docId }],
    GENERATE_TIMEOUT_MS,
  );
  say(
    `· 缺口读数：三态 ${Object.entries(gap.counts)
      .map(([state, count]) => `${state}=${String(count)}`)
      .join(' ')} · 比对行 ${String(gap.rows.length)} · 参与比对实体 ${String(gap.entityCount)} 条 · ` +
      `JD ${String(gap.inputChars)} 字 · 模型档 ${gap.modelStatus}${gap.modelReason ? ` · 原因：${gap.modelReason}` : ''}`,
  );
  requireStep(
    '段 4a 缺口报告按这份 JD 算得出',
    gap.rows.length > 0 && gap.entityCount > 0,
    `比对行 ${String(gap.rows.length)} · 参与比对实体 ${String(gap.entityCount)} 条`,
  );
  const before = await callBridge<ExportReceipt>(bridge, 'resume.export.toPdf', [imported.docId], 120_000);
  say(
    `· 定制前产物：${before.path} ${String(before.pages)} 页 ${String(before.bytes)} 字节 hash=${before.hash.slice(0, 12)}`,
  );
  const generated = await callBridge<GenerationRun>(
    bridge,
    'resume.generate.run',
    [jdText, { docId: imported.docId, jdId: chosen.jobId }],
    GENERATE_TIMEOUT_MS,
  );
  say(
    `· 生成读数：outcome=${generated.receipt.outcome} modelStatus=${generated.receipt.modelStatus} ` +
      `model=${String(generated.receipt.model ?? '无')} 改写 ${String(generated.rewrites.length)} 处 ` +
      `重排 ${String(generated.reorderBases.length)} 项 证据 ${String(generated.evidence.length)} 条 ` +
      `事实校验 ok=${String(generated.checks.ok)}（违规 ${String(generated.checks.violationCount)}）`,
  );
  say(`· 模型通道原因：${String(generated.receipt.modelReason ?? '无')}`);
  const indexes = generated.rewrites.map((_, index) => index);
  const accepted = await callBridge<GenerationAccept>(bridge, 'resume.generate.accept', [
    generated.receipt.id,
    { acceptedIndexes: indexes, applyReorder: true },
  ]);
  say(
    `· 接受读数：写入改写 ${String(accepted.appliedRewrites)} 处 重排=${String(accepted.reorderApplied)} ` +
      `移动区块 ${String(accepted.movedSections)} 条目 ${String(accepted.movedEntries)}`,
  );
  const after = await callBridge<ExportReceipt>(bridge, 'resume.export.toPdf', [imported.docId], 120_000);
  say(
    `· 定制后产物：${after.path} ${String(after.pages)} 页 ${String(after.bytes)} 字节 hash=${after.hash.slice(0, 12)} ` +
      `快照=${after.snapshotId}`,
  );
  const preview = await callBridge<string>(bridge, 'resume.export.preview', [imported.docId]);
  const jdTokens = chosen.requirements.slice(0, 3);
  const hitTokens = jdTokens.filter((token) => preview.includes(token));
  say(
    `· 产物里出现 JD 关键词：${hitTokens.join('、') || '无（重排通道本身不新增词面）'} / 取样 ${jdTokens.join('、') || '无'}`,
  );
  requireStep(
    '段 4 按 JD 定制并导出新 PDF',
    generated.checks.ok &&
      generated.receipt.outcome !== 'rejected' &&
      accepted.appliedRewrites + accepted.movedSections + accepted.movedEntries > 0 &&
      after.bytes > 0 &&
      after.hash !== before.hash,
    `outcome=${generated.receipt.outcome} 写入=${String(accepted.appliedRewrites)} 改写 / ${String(accepted.movedSections)} 区块 · 产物 hash ${before.hash.slice(0, 8)}→${after.hash.slice(0, 8)}`,
  );

  // 证据：把界面停在简历视图上拍一张，产物 PDF 复制一份到 tmp 供人复核。
  //
  // 这里**不用 CDP 派发鼠标**（`bridge.click`）：窗口未被带到前台时输入不落页，而且第二次调用会把
  // 那条 CDP 请求挂住不返回（§9 的 2.1-12 补窗，run 13 实测挂满 12 分钟由我手动终止）。
  // 切视图是 React 状态，`node.click()` 走组件自己的监听，拿到的是逻辑层的真相。
  const switchedView = await bridge.evaluate<string>(
    `(() => {
      const nodes = [...document.querySelectorAll('[data-view]')];
      const target = nodes.find((n) => /resume|kb|profile/.test(n.getAttribute('data-view') ?? ''));
      if (!target) return 'none';
      target.click();
      return target.getAttribute('data-view') ?? '';
    })()`,
  );
  await sleep(800);
  const shotPath = path.join(e2eDir, `e2e-${stamp}-app.png`);
  // 拍帧也兜一层：`Page.captureScreenshot` 在窗口 hidden 时照样出帧（§9 的 6.5-05 补窗），
  // 但视图正在导航时会挂住——挂住就如实记一句，不许把整条链的证据一起拖死。
  const tookShot = await Promise.race([bridge.screenshot(shotPath).then(() => true), sleep(20_000).then(() => false)]);
  say(
    tookShot
      ? `· 截图：${shotPath}（视图 ${String(switchedView ?? '未找到，停在当前视图')}）`
      : `· 截图未取得：CDP 拍帧 20s 未返回（视图 ${String(switchedView ?? '未知')}，判据读数与产物不受影响）`,
  );
  const copyTo = path.join(e2eDir, `e2e-${stamp}-resume.pdf`);
  writeFileSync(copyTo, readFileSync(after.path));
  say(`· 产物副本：${copyTo}`);

  // 这一条放在证据之后：模型通道没落时（run 6 那次是超时），上面的截图与 PDF 仍然是「仅重排」那份的真实产物，
  // 判据红在这里只说明「按 JD 定制」这一半没成，不该把已经拿到的证据一起丢掉。
  requireStep(
    '段 4b 模型通道按 JD 给出改写并被写入（不是仅重排的保守回落）',
    generated.receipt.modelStatus === 'merged' && accepted.appliedRewrites > 0,
    `modelStatus=${generated.receipt.modelStatus} 采纳改写 ${String(accepted.appliedRewrites)} 处 · 原因 ${String(generated.receipt.modelReason ?? '无')}`,
  );

  say('链路结论：段 1 导入 / 段 2 实体 / 段 3 搜 JD / 段 4 定制导出 / 段 4b 模型通道改写 全过。');
  void bridge.send('Browser.close').catch(() => undefined);
  const exitDeadline = Date.now() + 15_000;
  while (appExitCode === undefined && Date.now() < exitDeadline) await sleep(200);
  if (appExitCode === undefined) runningApp?.kill();
  try {
    bridge.close();
  } catch {
    /* 浏览器先走了 */
  }
  writeFileSync(logFile, `${lines.join('\n')}\n`, 'utf8');
  console.log(`读数已写入 ${logFile}`);
}

try {
  await main();
} catch (error) {
  lines.push(`链路结论：失败 —— ${error instanceof Error ? error.message : String(error)}`);
  console.error(lines[lines.length - 1]);
  try {
    runningBridge?.close();
  } catch {
    /* 会话本来就没建成 */
  }
  if (runningApp && runningApp.exitCode === null) runningApp.kill();
  mkdirSync(path.dirname(logFile), { recursive: true });
  writeFileSync(logFile, `${lines.join('\n')}\n`, 'utf8');
  process.exit(1);
}
