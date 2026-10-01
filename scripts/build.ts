/**
 * 生产态构建：bundle 主进程与 preload、构建渲染层、注入 CSP，组装 electron-builder 的 staging 目录。
 *
 * staging 里只有**运行期外置的那几个包**（`mammoth` + `pdfjs-dist` 及其传递依赖）会以 `node_modules`
 * 形式落盘，其余依赖全部被 esbuild 内联进 `main.cjs`。「外置哪些」的唯一真相源在
 * `vendor-runtime-deps.ts`，为什么必须外置（pdf.js worker 相对自身解析）见
 * `docs/plans/04-resume-kb/plan.md` §1.2（spec 4.1-c 决策：依赖外置 + `asarUnpack`）。
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { RUNTIME_ESBUILD_EXTERNAL, resolveRuntimeDeps, vendorRuntimeDeps } from './vendor-runtime-deps.js';

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
      external: RUNTIME_ESBUILD_EXTERNAL,
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

/** staging 的 package.json：元数据 + 运行期外置依赖声明（不声明的话 electron-builder 的依赖收集会把它们当野文件）。 */
function writeAppManifest(deps: readonly { name: string; version: string }[]): void {
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
        dependencies: Object.fromEntries(deps.map(({ name, version }) => [name, version])),
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
const vendored = vendorRuntimeDeps(path.join(appDir, 'node_modules'), resolveRuntimeDeps());
writeAppManifest(vendored);

console.log(
  `[build] staging 就绪：${path.relative(repoRoot, appDir)}（外置依赖 ${String(vendored.length)} 个：${vendored
    .map(({ name, version }) => `${name}@${version}`)
    .join(' ')}）`,
);
