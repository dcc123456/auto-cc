/**
 * 生产态构建：bundle 主进程与 preload、构建渲染层、注入 CSP，组装 electron-builder 的 staging 目录。
 *
 * staging 里只放 `package.json` + 两份 cjs + `renderer/`，没有 `node_modules`：esbuild 把 cordis 与全部
 * `@auto-cc/*` 内联进 `main.cjs`（external 只留 electron），所以「零依赖产物」是构建结构本身保证的，
 * 不是打包后再筛选（spec §8.2 决策 1 / 验收 1.7-12）。
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { build as viteBuild } from 'vite';

const repoRoot = path.resolve(import.meta.dirname, '..');
const appDir = path.join(repoRoot, 'build', 'app');
const rendererRoot = path.join(repoRoot, 'packages', 'renderer');

/**
 * 打包版渲染层的 CSP。`style-src` 刻意不给 `unsafe-inline`：Tailwind 产出的是外链 CSS，
 * 渲染层又被 lint 禁止内联 `style`（AGENTS.md §5.1），一旦这里出现违规就说明有代码破了两条硬约束。
 * 开发态不加 CSP —— vite 要注入内联 preamble 并开 HMR（spec §1.2 事实第 5 条）。
 */
const RENDERER_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** esbuild 的一次性（非 watch）产物，输出直接落到 staging。 */
async function bundleMainProcess(): Promise<void> {
  for (const [entry, outfile] of [
    [path.join(repoRoot, 'packages', 'main', 'src', 'index.ts'), path.join(appDir, 'main.cjs')],
    [path.join(repoRoot, 'packages', 'preload', 'src', 'index.ts'), path.join(appDir, 'preload.cjs')],
  ] as const) {
    await build({
      absWorkingDir: repoRoot,
      entryPoints: [entry],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      external: ['electron'],
      logLevel: 'warning',
    });
  }
}

/** 给入口 HTML 插入 CSP meta；放在 `<head>` 之后，确保在任何脚本执行前生效。 */
function injectCsp(htmlFile: string): void {
  const html = readFileSync(htmlFile, 'utf8');
  if (html.includes('Content-Security-Policy')) return;
  const head = '<head>';
  const at = html.indexOf(head);
  if (at < 0) throw new Error(`构建产物缺少 <head>：${htmlFile}`);
  const meta = `${head}\n    <meta http-equiv="Content-Security-Policy" content="${RENDERER_CSP}" />`;
  writeFileSync(htmlFile, html.replace(head, meta));
}

/** staging 的 package.json：只带 electron-builder 需要的元数据，零依赖。 */
function writeAppManifest(): void {
  const root = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    version: string;
    description: string;
  };
  writeFileSync(
    path.join(appDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'auto-cc',
        version: root.version,
        description: root.description,
        main: './main.cjs',
        author: { name: 'auto-cc', email: 'auto-cc@example.com' },
        license: 'UNLICENSED',
        private: true,
      },
      null,
      2,
    )}\n`,
  );
}

/**
 * 校验 `electron-builder.yml` 显式声明的 `electronVersion` 与真实安装的 electron 一致。
 * 不一致说明要打包的内核不是 dev 与验收跑过的那个 —— 宁可构建失败，也不静默换内核。
 */
function assertElectronVersion(): void {
  const electronPkg = path.join(repoRoot, 'packages', 'main', 'node_modules', 'electron', 'package.json');
  const installed = (JSON.parse(readFileSync(electronPkg, 'utf8')) as { version: string }).version;
  const declared = /^electronVersion:\s*(\S+)$/m.exec(
    readFileSync(path.join(repoRoot, 'electron-builder.yml'), 'utf8'),
  )?.[1];
  if (declared !== installed) {
    throw new Error(
      `electron-builder.yml 的 electronVersion=${String(declared)} 与已安装的 electron ${installed} 不一致`,
    );
  }
}

assertElectronVersion();
rmSync(appDir, { recursive: true, force: true });
mkdirSync(appDir, { recursive: true });

await bundleMainProcess();
await viteBuild({ root: rendererRoot, logLevel: 'warn' });
cpSync(path.join(rendererRoot, 'dist'), path.join(appDir, 'renderer'), { recursive: true });
injectCsp(path.join(appDir, 'renderer', 'index.html'));
writeAppManifest();

console.log(`[build] staging 就绪：${path.relative(repoRoot, appDir)}`);
