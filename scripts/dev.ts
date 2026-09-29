/**
 * 开发态编排：打包主进程与 preload（esbuild → CJS）+ 起 Vite 渲染层 + 拉 Electron。
 *
 * 之所以要自己 bundle：Electron 主进程与 sandbox preload 只吃 CJS，而仓库全量 ESM/TS。
 * 主进程/preload 变更会重启 Electron，渲染层变更走 Vite HMR（1.2-03）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { context, type Plugin } from 'esbuild';
import { createServer } from 'vite';

const repoRoot = path.resolve(import.meta.dirname, '..');
const mainEntry = path.join(repoRoot, 'packages', 'main', 'src', 'index.ts');
const preloadEntry = path.join(repoRoot, 'packages', 'preload', 'src', 'index.ts');
const distDir = path.join(repoRoot, 'packages', 'main', 'dist');
const rendererRoot = path.join(repoRoot, 'packages', 'renderer');
const cdpPort = process.env.AUTO_CC_CDP_PORT ?? '9222';
const rendererUrl = process.env.ELECTRON_RENDERER_URL ?? 'http://127.0.0.1:5173';

let electron: ChildProcess | undefined;
let restartTimer: NodeJS.Timeout | undefined;

/** Electron 只属于 packages/main 的 devDependencies，因此从该包解析二进制路径。 */
function resolveElectron(): string {
  const require = createRequire(path.join(repoRoot, 'packages', 'main', 'package.json'));
  return require('electron') as string;
}

function launchElectron() {
  electron = spawn(resolveElectron(), [path.join(distDir, 'main.cjs'), `--remote-debugging-port=${cdpPort}`], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RENDERER_URL: rendererUrl },
  });
  electron.on('exit', (code) => {
    console.log(`[dev] electron exited (${String(code)})`);
    process.exit(0);
  });
}

function restartElectron() {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    // 先摘掉 exit 监听：否则被我们主动 kill 的旧进程会触发 process.exit(0)，把整个 dev 会话带走。
    electron?.removeAllListeners('exit');
    electron?.kill();
    launchElectron();
  }, 300);
}

/** esbuild 每轮成功产出后拉起或重启 Electron；首次的两个入口产物由同一轮防抖合并成一次启动。 */
const restartPlugin: Plugin = {
  name: 'restart-electron',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return;
      restartElectron();
    });
  },
};

async function bundle(entry: string, outfile: string, restart: boolean) {
  const ctx = await context({
    absWorkingDir: repoRoot,
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    sourcemap: true,
    logLevel: 'warning',
    plugins: restart ? [restartPlugin] : [],
  });
  await ctx.watch();
}

const server = await createServer({ root: rendererRoot });
await server.listen();
console.log(`[dev] renderer at ${String(server.resolvedUrls?.local[0])}`);

await bundle(preloadEntry, path.join(distDir, 'preload.cjs'), true);
await bundle(mainEntry, path.join(distDir, 'main.cjs'), true);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    electron?.kill();
    void server.close().finally(() => process.exit(0));
  });
}
