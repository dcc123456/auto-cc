/**
 * 运行期外置依赖：esbuild 不打进 bundle 的那几个包，由构建脚本搬运成真实目录。
 *
 * 为什么必须外置而不是内联（实测，见 docs/plans/04-resume-kb/plan.md §1.2）：pdf.js 的 worker 是
 * 相对自身文件解析的 ESM，内联进 `main.cjs` 后运行期报 `Cannot find module '<产物目录>/pdf.worker.mjs'`。
 *
 * 为什么清单要从 package.json 递归解析而不是手填：漏一个传递依赖就是「装机后才炸」，
 * 构建期看不出来；这里唯一允许的人工输入是 `RUNTIME_EXTERNAL_ROOTS`（哪几个包要外置）。
 */
import { cpSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
/** 外置根的声明方 —— 这两个包的代码在 resume-kb 里，运行期由主进程加载。 */
const declaringPackage = path.join(repoRoot, 'packages', 'resume-kb', 'package.json');

/** 需要外置的包名（esbuild external 与搬运清单的共同真相源）。 */
export const RUNTIME_EXTERNAL_ROOTS = ['mammoth', 'pdfjs-dist', 'electron-updater'] as const;

/** 搬运层随包落地的第三方许可全文文件名（spec 5.9-04 的 NOTICE 半边；写在 `node_modules` 根旁边）。 */
export const THIRD_PARTY_NOTICES_FILE = 'THIRD-PARTY-NOTICES.txt';

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
  readonly license?: string | { readonly type?: string; readonly url?: string };
  readonly author?: string | { readonly name?: string; readonly email?: string };
  readonly repository?: string | { readonly type?: string; readonly url?: string };
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
 * 在一个包目录里找许可全文文件（只看顶层，不递归——发布物约定许可在包根）。
 * 判据形状 `licence/license/copying/authors` 覆盖 npm 生态里出现过的四种写法。
 * @param dir 包目录（`resolveRuntimeDeps()` 给的 `dir`，或搬运后的目标目录）
 * @returns 文件名；没有许可全文时返回 null（由调用方决定是失败还是记账）
 */
export function findLicenseFileIn(dir: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  return entries.find((entry) => /^(licen[cs]e|copying|authors)\b/i.test(entry)) ?? null;
}

/** 把 manifest 里三种合法形状（字符串 / `{type,url}` / 对象作者）归一成一行的展示串。 */
function oneLine(value: PackageManifest[keyof PackageManifest] | undefined): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name : '';
    const type = typeof record.type === 'string' ? record.type : '';
    const url = typeof record.url === 'string' ? record.url : '';
    return [name, type, url].filter(Boolean).join(' ') || JSON.stringify(record);
  }
  return '';
}

/**
 * 生成搬运层的第三方许可全文汇总（spec 5.9-04：随包分发要把条文带上）。
 *
 * 为什么单独出一份而不是只靠每个包目录里的 LICENSE：`isarray@1.0.0` 这类老包的 **npm 发布物里根本没有
 * 许可全文**（实测：目录内只有 Makefile/README/component.json/index.js/package.json/test.js），
 * 而它的 MIT 义务是"分发时要带版权声明"。这里的做法是**从包自己的 manifest 元数据登记**
 * （license 字段、author、repository），并在缺全文的那一条写明"缺的是上游发布物，不是我们漏拷"——
 * 不去从网上补抄一份条文：那是凭记忆编造许可文本，风险比登记缺口大（§8 的诚实纪律）。
 * @param nodeModulesDir 搬运目标根（`build/app/node_modules`）
 * @param deps 搬运清单
 * @returns 写出的文件绝对路径
 */
export function emitThirdPartyNotices(nodeModulesDir: string, deps: readonly VendoredDep[]): string {
  const blocks = deps.map((dep) => {
    const manifest = readManifest(dep.dir);
    const licenseFile = findLicenseFileIn(dep.dir);
    const header =
      `[${dep.name}] ${dep.version}\n  license    : ${oneLine(manifest.license) || '(未在 manifest 中声明)'}\n` +
      `  author     : ${oneLine(manifest.author) || '(未知)'}\n` +
      `  repository : ${oneLine(manifest.repository) || '(未知)'}\n`;
    if (licenseFile === null) {
      return (
        `${header}  notice     : 上游发布物内无许可全文（实测包目录里没有 LICENSE/COPYING 类文件）。` +
        '本条按 manifest 的 license 字段登记；已在 LICENSES.md 的 copyleft/缺失全文处置表中记录。\n'
      );
    }
    const text = readFileSync(path.join(dep.dir, licenseFile), 'utf8').trim();
    return `${header}  notice     : 以下转录包内 ${licenseFile}\n\n${text}\n`;
  });
  const content =
    `搬运层（esbuild 外置、随 app 一起分发的运行期依赖）的第三方许可汇总。\n` +
    `由 scripts/vendor-runtime-deps.ts 在构建时生成，共 ${String(deps.length)} 个包。\n` +
    `人工记账与全量生产依赖清单见仓库根的 LICENSES.md。\n\n${blocks.join('\n')}\n`;
  const target = path.join(path.dirname(nodeModulesDir), THIRD_PARTY_NOTICES_FILE);
  writeFileSync(target, content, 'utf8');
  return target;
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
  emitThirdPartyNotices(nodeModulesDir, deps);
  return deps;
}

/** esbuild 的 external 不做前缀匹配，子路径必须单列（`pdfjs-dist/legacy/build/pdf.mjs` 是动态 import 的实参）。 */
export const RUNTIME_ESBUILD_EXTERNAL = ['electron', ...RUNTIME_EXTERNAL_ROOTS.flatMap((name) => [name, `${name}/*`])];
