/**
 * 运行期外置依赖：esbuild 不打进 bundle 的那几个包，由构建脚本搬运成真实目录。
 *
 * 为什么必须外置而不是内联（实测，见 docs/plans/04-resume-kb/plan.md §1.2）：pdf.js 的 worker 是
 * 相对自身文件解析的 ESM，内联进 `main.cjs` 后运行期报 `Cannot find module '<产物目录>/pdf.worker.mjs'`。
 *
 * 为什么清单要从 package.json 递归解析而不是手填：漏一个传递依赖就是「装机后才炸」，
 * 构建期看不出来；这里唯一允许的人工输入是 `RUNTIME_EXTERNAL_ROOTS`（哪几个包要外置）。
 */
import { cpSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
/** 外置根的声明方 —— 这两个包的代码在 resume-kb 里，运行期由主进程加载。 */
const declaringPackage = path.join(repoRoot, 'packages', 'resume-kb', 'package.json');

/** 需要外置的包名（esbuild external 与搬运清单的共同真相源）。 */
export const RUNTIME_EXTERNAL_ROOTS = ['mammoth', 'pdfjs-dist'] as const;

/**
 * pdf.js 的包体里与「Node 侧抽文本」无关的大目录：`web/` 是浏览器阅读器 UI，`types/` 是 .d.ts。
 * 其余（`build/`、`legacy/`、`cmaps/`、`standard_fonts/`、`wasm/`、`image_decoders/`、`iccs/`）保留——
 * cmaps 与标准字体是 CJK PDF 抽文本的必需资源，砍掉就是中文简历解析失败。
 */
const PRUNED_PACKAGE_DIRS: Readonly<Record<string, readonly string[]>> = {
  'pdfjs-dist': ['web', 'types'],
};

export interface VendoredDep {
  readonly name: string;
  readonly version: string;
  /** pnpm 软链解析后的真实包目录。 */
  readonly dir: string;
}

interface PackageManifest {
  readonly version: string;
  readonly dependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
}

function readManifest(dir: string): PackageManifest {
  return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as PackageManifest;
}

/**
 * 从 `RUNTIME_EXTERNAL_ROOTS` 出发做传递闭包。
 * 顶层包从声明方（resume-kb）解析，子依赖从父包目录解析 —— 与运行期的真实解析方向一致。
 * 只看 `dependencies`：`optionalDependencies` 里的 `@napi-rs/canvas` 是原生模块（4.3-06 明确不引入需编译的扩展），
 * 抽文本路径不碰它，缺失时 pdf.js 自己走不到那条分支。
 * 两个根包都**不带 `exports` 字段**（实测），所以 `<name>/package.json` 一定能直接 resolve 到包根。
 * 下面的 `for (const ... of queue)` 边遍历边追加：Array 迭代器每步重读 length，所以一趟就能吃完整棵树。
 * @returns 按包名排序的实体依赖列表（同一包名只算一次，防止依赖成环）
 */
export function resolveRuntimeDeps(): VendoredDep[] {
  const requireFromDeclaringPackage = createRequire(declaringPackage);
  const found = new Map<string, VendoredDep>();
  const queue = RUNTIME_EXTERNAL_ROOTS.map((name) => ({
    name,
    dir: realpathSync(path.dirname(requireFromDeclaringPackage.resolve(`${name}/package.json`))),
  }));
  for (const pending of queue) {
    if (found.has(pending.name)) continue;
    const manifest = readManifest(pending.dir);
    found.set(pending.name, { name: pending.name, version: manifest.version, dir: pending.dir });
    const requireFromParent = createRequire(path.join(pending.dir, 'package.json'));
    for (const child of Object.keys(manifest.dependencies ?? {})) {
      if (found.has(child)) continue;
      queue.push({ name: child, dir: realpathSync(path.dirname(requireFromParent.resolve(`${child}/package.json`))) });
    }
  }
  return [...found.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * 把外置依赖搬进某个 `node_modules` 根目录，供 `main.cjs` 运行期解析。
 * 目标目录每次先清空对应包，保证重复构建不残留旧版本文件。
 * @param nodeModulesDir 形如 `build/app/node_modules` 的目标根
 * @param deps `resolveRuntimeDeps()` 的结果
 * @returns 实际搬运的包列表（打日志与体积审计用）
 */
export function vendorRuntimeDeps(nodeModulesDir: string, deps: readonly VendoredDep[]): VendoredDep[] {
  mkdirSync(nodeModulesDir, { recursive: true });
  for (const { name, dir } of deps) {
    const dest = path.join(nodeModulesDir, name);
    rmSync(dest, { recursive: true, force: true });
    const pruned = new Set(PRUNED_PACKAGE_DIRS[name] ?? []);
    cpSync(dir, dest, {
      recursive: true,
      filter: (src) =>
        !src.endsWith('.map') &&
        !(path.relative(dir, src).split(path.sep).length === 1 && pruned.has(path.basename(src))),
    });
  }
  return deps;
}

/** esbuild 的 external 不做前缀匹配，子路径必须单列（`pdfjs-dist/legacy/build/pdf.mjs` 是动态 import 的实参）。 */
export const RUNTIME_ESBUILD_EXTERNAL = ['electron', ...RUNTIME_EXTERNAL_ROOTS.flatMap((name) => [name, `${name}/*`])];
