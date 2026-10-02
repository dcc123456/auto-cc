/**
 * 离线依赖门槛机检（spec 4.3-05 / 4.3-06，plan §4.3-e 实现形状 2）。
 *
 * 这两条验收的失效模式很具体：**某次顺手 `pnpm add`**。今天"只用内置 sqlite、只走远端 embedding API"
 * 是干净的，明天有人为了向量检索装个 ChromaDB、或者嫌 `node:sqlite` 不熟装个 `better-sqlite3`，
 * 项目就从"用户只装一个 app"变成"用户还要跑一个服务 / 装一套编译链"（主计划 §1.4 的地基）。
 * 所以这里把它落成常驻机检（进 `pnpm lint` 链），而不是一次人肉 `pnpm why`。
 *
 * 三层扫描，各管一段，缺一层就会漏：
 * 1. **声明层**：每个 `package.json` 的四类依赖表里不得出现任何禁令（能力类 + 原生编译类）。
 *    「我们主动引入的」才是我们的决定，这一层管的是决定。
 * 2. **解析层**：`pnpm-lock.yaml` 全量包名扫一遍（传递依赖也拦得住，且不依赖本机装没装，比 `pnpm why` 强）。
 *    这一层**只判能力类禁令**：外来向量库 / 向量服务 / docker 客户端 / 非内置 SQLite 绑定。
 *    锁文件里本来就有的 dev-only 传递原生链路（`node-gyp`、pdfjs 的 optional `@napi-rs/canvas` 家族，
 *    实测见 pnpm-lock.yaml 的 1099～1170 行与 2524 行）**只记为提示**——它们不是本项目的检索能力，
 *    也不该由 lint 决定"整个 npm 生态里不许有编译工具"；它们会不会落到用户机上由第三层判。
 *    这条边界写在这里而不是悄悄放宽，是为了让下一个人一眼看见机检守了什么、没守什么。
 * 3. **搬运层**：装机用户真正会拿到的那批包——`scripts/vendor-runtime-deps.ts` 的 `resolveRuntimeDeps()`
 *    闭包（esbuild 外置依赖的唯一真相源，1.7-15 的搬运审计读的也是它，§2.1 复用）。
 *    逐个包目录里不得有 `.node` / `.dll` / `.so` / `.dylib` / `binding.gyp`，也不得有
 *    `preinstall` / `install` / `postinstall`（这三个脚本会在装依赖时跑本机编译；`prepare` / `pretest`
 *    从 registry 装时不触发，实测 mammoth 带 `prepare` 而不算命中）。`.wasm` 是**预编译产物**、
 *    不需要用户机编译，不在禁止之列（pdfjs 的 `wasm/` 是 CJK 字体解码的必需资源，砍掉就是中文简历解析失败）。
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { resolveRuntimeDeps } from './vendor-runtime-deps.js';

const repoRoot = path.resolve(import.meta.dirname, '..');

/** 一条禁令：包名模式 + 它对应的那次否决（写清出处，禁止清单不是随手列的黑名单）。 */
interface Ban {
  readonly pattern: RegExp;
  readonly reason: string;
}

/** 能力类禁令：出现在依赖树任何一层都算（引入它们就是"用户还要装一个服务/一个引擎"）。 */
const CAPABILITY_BANS: readonly Ban[] = [
  {
    pattern: /^(?:chromadb?|@chroma\/.+|chroma-client)$/i,
    reason: 'ChromaDB 客户端（spec 4.3-05：向量只能经 `llm.embed` 的远端 API 拿，不在本机养一个向量服务）',
  },
  {
    pattern: /^(?:qdrant|@qdrant\/.+|weaviate-ts-client|weaviate-client|milvus2?|@zilliz\/.+)$/i,
    reason: '外来向量数据库客户端（spec 4.3-05，plan §4.3-d 候选表第 3 行已否决）',
  },
  {
    pattern: /^(?:lancedb|faiss[-\w]*|hnswlib[-\w]*|usearch|annoy|n2|pgvector)$/i,
    reason: '本机向量索引库或向量扩展（spec 4.3-05 / 4.3-06：要么带二进制要么带编译链）',
  },
  {
    pattern: /^(?:dockerode|docker-modem|docker-client)$/,
    reason: 'Docker 客户端（外部服务意味着用户要多装一样东西，主计划 §1.4「用户只装一个 app」）',
  },
  {
    pattern: /^(?:better-sqlite3|sqlite3|node-sqlite3-wasm|sqlite-vec|@sqlite\/.+)$/,
    reason:
      '非内置的 SQLite 绑定或向量扩展（AGENTS.md §9 已实测 `node:sqlite` 在 Electron 44 主进程直接可用，禁止原生编译依赖）',
  },
];

/** 原生编译链禁令：只许出现在声明层（传递依赖里由搬运层判它是否进装机包）。 */
const NATIVE_BANS: readonly Ban[] = [
  {
    pattern: /^(?:@napi-rs\/.+|@node-rs\/.+|@mapbox\/node-pre-gyp|prebuild-install|bindings|node-gyp)$/,
    reason: '需用户机编译或按平台下载二进制的原生链路（spec 4.3-06）',
  },
];

/** 搬运层要挑出来的原生产物文件（`.wasm` 不在内：预编译产物，用户机不需要编译）。 */
const NATIVE_ARTIFACT = /\.(node|dll|so|dylib|o)$|^binding\.gyp$/;

/** 会在装依赖时执行的本机编译钩子（`prepare` 从 registry 安装时不跑，故不在内，见文件头注释）。 */
const COMPILE_SCRIPTS = ['preinstall', 'install', 'postinstall'];

const failures: string[] = [];
/** 解析层命中的原生链路包名（只作提示，判不判失败由搬运层决定，见文件头第 2 层注释）。 */
const nativeLockNames: string[] = [];

const banOf = (name: string, bans: readonly Ban[]): Ban | undefined => bans.find((ban) => ban.pattern.test(name));

/**
 * 把平台变体归到同一个家族名（提示行要短：`@napi-rs/canvas` 一家就有 11 个变体，一行一个会把结论淹没）。
 * @param name 包名
 * @returns 去掉 `-<平台>-<架构>` 尾巴后的名字；不含平台尾巴时原样返回（如 `node-gyp`）
 */
function familyOf(name: string): string {
  const platformTail = /^(.*?)-(?:android|darwin|linux|win32|freebsd|openbsd)-/.exec(name);
  return platformTail?.[1] ?? name;
}

/**
 * 扫一份 `package.json` 的四类依赖表（声明层）。
 * @param relPath 相对仓库根的清单文件路径（报错时指得清）
 * @param manifest 解析出的清单对象
 * @returns 无返回值（命中写进 `failures`）
 */
function checkManifest(relPath: string, manifest: Record<string, unknown>): void {
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const deps = manifest[field];
    if (typeof deps !== 'object' || deps === null) continue;
    for (const name of Object.keys(deps)) {
      for (const ban of [...CAPABILITY_BANS, ...NATIVE_BANS]) {
        if (ban.pattern.test(name)) failures.push(`${relPath} 的 ${field} 里声明了 ${name}：${ban.reason}`);
      }
    }
  }
}

/**
 * 递归收集目录里的文件名（搬运层的原生产物扫描用）。
 * @param dir 起始目录（`resolveRuntimeDeps()` 给的真实包目录，已跟过软链）
 * @returns 该目录树下的文件名列表（只要 basename：判据是"有没有二进制产物"，不是路径审计）
 */
async function fileNamesUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) found.push(...(await fileNamesUnder(path.join(dir, entry.name))));
    else found.push(entry.name);
  }
  return found;
}

/**
 * 从锁文件的包键里取包名。
 * @param key 形如 `name@1.2.3`、`@napi-rs/canvas@1.0.9`、`name@1.0.0(peer@2)`
 * @returns 包名；取不出作用域前缀之外的 `@` 时原样返回
 */
function nameOfLockKey(key: string): string {
  const withoutPeer = key.replace(/\(.*$/, '');
  const at = withoutPeer.lastIndexOf('@');
  return at <= 0 ? withoutPeer : withoutPeer.slice(0, at);
}

// —— 第一层：声明层（根 + 每个包）——
const packageRoot = path.join(repoRoot, 'packages');
const workspaceDirs = (await readdir(packageRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(packageRoot, entry.name));
const manifestPaths = [
  path.join(repoRoot, 'package.json'),
  ...workspaceDirs.map((dir) => path.join(dir, 'package.json')),
];
let manifestsScanned = 0;
for (const filePath of manifestPaths) {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    continue; // 没有 package.json 的目录不参与本轮判定（本仓当前每个 packages/* 都有）
  }
  manifestsScanned += 1;
  checkManifest(path.relative(repoRoot, filePath).replaceAll('\\', '/'), JSON.parse(raw) as Record<string, unknown>);
}

// —— 第二层：解析层（锁文件里两空格缩进的包键，即 `packages:` / `snapshots:` 的条目）——
const lockText = await readFile(path.join(repoRoot, 'pnpm-lock.yaml'), 'utf8');
const lockNames = new Set<string>();
for (const match of lockText.matchAll(/^ {2}'?([^':\s]+)'?:/gm)) {
  lockNames.add(nameOfLockKey(match[1] ?? ''));
}
for (const name of lockNames) {
  const capability = banOf(name, CAPABILITY_BANS);
  if (capability) {
    failures.push(`pnpm-lock.yaml 的依赖树里解析出 ${name}：${capability.reason}`);
    continue;
  }
  if (banOf(name, NATIVE_BANS)) {
    nativeLockNames.push(name);
  }
}

// —— 第三层：搬运层（装机用户真正拿到的闭包）——
const runtimeDeps = resolveRuntimeDeps();
let runtimeFilesScanned = 0;
for (const dep of runtimeDeps) {
  const manifest = JSON.parse(await readFile(path.join(dep.dir, 'package.json'), 'utf8')) as Record<string, unknown>;
  const scripts = manifest.scripts;
  if (typeof scripts === 'object' && scripts !== null) {
    for (const hook of COMPILE_SCRIPTS) {
      if (hook in (scripts as Record<string, string>)) {
        failures.push(
          `装机依赖 ${dep.name}@${dep.version} 带 ${hook} 脚本：用户装 app 时会触发本机编译（spec 4.3-06）`,
        );
      }
    }
  }
  if (banOf(dep.name, [...CAPABILITY_BANS, ...NATIVE_BANS])) {
    failures.push(`装机依赖闭包里有 ${dep.name}@${dep.version}：它本不该出现在运行期外置依赖里（spec 4.3-05 / 06）`);
  }
  const files = await fileNamesUnder(dep.dir);
  runtimeFilesScanned += files.length;
  const native = files.filter((name) => NATIVE_ARTIFACT.test(name));
  if (native.length > 0) {
    failures.push(
      `装机依赖 ${dep.name}@${dep.version} 内含原生产物 ${native.slice(0, 3).join('、')}` +
        `${native.length > 3 ? ` 等 ${String(native.length)} 个` : ''}：需要用户机编译或按平台下载二进制（spec 4.3-06）`,
    );
  }
}

if (failures.length) {
  console.error('✖ 离线依赖门槛机检未通过（spec 4.3-05 无外部向量服务 / 4.3-06 无本机编译扩展）：');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(
  `✔ 离线依赖门槛机检通过（${String(manifestsScanned)} 份 package.json + 锁文件 ${String(lockNames.size)} 个包名 + ` +
    `${String(runtimeDeps.length)} 个装机依赖共 ${String(runtimeFilesScanned)} 个文件：` +
    '无外来向量库/向量服务/docker 客户端、无非内置 SQLite 绑定、装机闭包内无原生二进制与安装期编译脚本）',
);
if (nativeLockNames.length > 0) {
  // 一条汇总而不是 14 行：这组名字不构成失败也不构成通过，只是告诉下一个人"机检看见它们了，是有意放过"。
  const families = [...new Set(nativeLockNames.map(familyOf))].sort((left, right) => left.localeCompare(right));
  console.log(
    `  · 锁文件里有 ${String(nativeLockNames.length)} 个原生编译链包名（${families.join('、')} 的家族与平台变体）：` +
      `均为传递依赖、非本项目声明，且搬运层已确认它们不在 ${String(runtimeDeps.length)} 个装机依赖里 —— ` +
      '会不会落到用户机上以搬运层为准。',
  );
}
