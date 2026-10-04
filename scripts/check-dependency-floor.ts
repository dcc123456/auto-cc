/**
 * 离线依赖门槛机检（spec 4.3-05 / 4.3-06，plan §4.3-e 实现形状 2；5.8-06 的图表库禁令并入同一台机检）。
 *
 * 这两条验收的失效模式很具体：**某次顺手 `pnpm add`**。今天"只用内置 sqlite、只走远端 embedding API"
 * 是干净的，明天有人为了向量检索装个 ChromaDB、或者嫌 `node:sqlite` 不熟装个 `better-sqlite3`，
 * 项目就从"用户只装一个 app"变成"用户还要跑一个服务 / 装一套编译链"（主计划 §1.4 的地基）。
 * 5.8-06 是同一个失效模式的第三种写法：某天有人把看板的宽度条"升级"成 chart.js，
 * 那是运行期依赖变重、不是服务变多，所以并入这里而不是另起一台机检（§2.2 同一条逻辑只留一个入口）。
 * 所以这里把它落成常驻机检（进 `pnpm lint` 链），而不是一次人肉 `pnpm why`。
 *
 * 三层扫描，各管一段，缺一层就会漏：
 * 1. **声明层**：每个 `package.json` 的四类依赖表里不得出现任何禁令（`TREE_BANS` = 能力类 + 图表类，加原生编译类）。
 *    「我们主动引入的」才是我们的决定，这一层管的是决定。
 * 2. **解析层**：`pnpm-lock.yaml` 全量包名扫一遍（传递依赖也拦得住，且不依赖本机装没装，比 `pnpm why` 强）。
 *    这一层判 `TREE_BANS`：外来向量库 / 向量服务 / docker 客户端 / 非内置 SQLite 绑定 / 图表与图形引擎（spec 5.8-06）。
 *    唯一例外是 `CANVAS_APPROVED` 那两只画布包带下来的图表类传递链（spec 5.10-01，plan §7.8.2 裁定六）：
 *    放行条件写在**来源**上（父边必须全部落在画布族里），不写在包名上，所以看板那条判据没有被削弱。
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

/**
 * 图与流程图画布的**核准例外**（spec 5.10-01 / 5.10-16，plan §7.8.2 裁定六）。
 *
 * 下面那条「图与流程图渲染引擎」禁令的原文就写着「5.10 若要引入须先按 §6 取证再改这条」，
 * 所以这不是悄悄放宽，而是走那条既定的口子：取证在 plan §5.10.1（本机 `npm view @xyflow/react`
 * = 12.12.0、MIT、peer react>=17），改动只到这里，并且**边界收得很紧**——
 * ① 只许渲染层声明（`packages/renderer`），别处声明即失败；
 * ② 它带进来的 `d3-*` / `@types/d3-*` 传递链只认「父包是画布族或同样是画布族传下来的」这一种来源，
 *    任何别的包（含各 workspace 的 package.json）直接依赖 d3 仍旧算违反 5.8-06；
 * ③ 画布族与它的 d3 传递链一律不得进装机运行期闭包（第三层照旧判禁，画布是 Vite 打进 bundle 的）。
 * 看板那条判据（5.8-06「比例宽度条 + 精确数字够用」）因此一个字都没被削弱。
 */
const CANVAS_APPROVED = ['@xyflow/react', '@xyflow/system'] as const;
const CANVAS_APPROVED_SET: ReadonlySet<string> = new Set<string>(CANVAS_APPROVED);

/**
 * 图表与图形渲染库禁令（spec 5.8-06「不引重型图表库」，plan §7.6.2 决策十九）。
 *
 * 失效模式与上面两类同形：某天有人觉得"漏斗该画成真的图"，`pnpm add` 一只 chart.js 或 echarts，
 * 于是渲染层多一个几十 KB～几百 KB 的运行期依赖、而判据早就写明"比例宽度条 + 精确数字"够用。
 * 这条也不是一次人肉 review 能守住的，所以进同一台机检的三层：声明、解析（含传递依赖）、搬运。
 * 名单按家族列而不逐个版本号：`d3-*` / `@antv/*` / `@nivo/*` / `@pixi/*` 这类作用域与前后缀变体
 * 都是同一次决定的不同写法。
 */
const VISUALIZATION_BANS: readonly Ban[] = [
  {
    pattern: /^(?:chart\.js|chartjs-.*|@chartjs\/.+)$/i,
    reason: '图表库（spec 5.8-06：看板用十分位宽度条，界面不引图表库；决策十九）',
  },
  {
    pattern: /^(?:echarts|@antv\/.+|antv)$/i,
    reason: '图表库（spec 5.8-06 同一条否决）',
  },
  {
    pattern: /^(?:recharts|victory|@victory(?:components|native)\/.+|semiotic|@nivo\/.+|@vx\/.+|visx)$/i,
    reason: 'React 图表组件库（spec 5.8-06 同一条否决）',
  },
  {
    pattern: /^(?:d3|d3-.*|@types\/d3.*|highcharts|highcharts-react-official|apexcharts|plotly\.js|c3|morris)$/i,
    reason: '绘图与图表库（spec 5.8-06；§5.3 的 lucide-only 也不允许为了画图引入 SVG 手绘链路）',
  },
  {
    pattern: /^(?:konva|react-konva|pixi\.js|@pixi\/.+|fabric|three|@react-three\/.+|babylonjs)$/i,
    reason: 'Canvas / WebGL 图形引擎（spec 5.8-06：看板不是画布，画布类需求走 5.10 另行取证）',
  },
  {
    pattern: /^(?:mermaid|dagre|@dagrejs\/.+|elkjs|gojs|jointjs|cytoscape|vis-network|vis-data)$/i,
    reason:
      '图与流程图渲染引擎（spec 5.8-06 同一条否决；5.10 的画布例外只走 CANVAS_APPROVED 那一条已取证的路，别的引擎仍旧禁止）',
  },
];

/**
 * 依赖树三层都要判的禁令合集（能力类 + 图表类）。
 * 原生编译链不在内：它的语义是"声明层禁止、传递链路只提示、是否落到用户机上由搬运层判"，
 * 见文件头第 2 层与第 3 层的边界说明。
 */
const TREE_BANS: readonly Ban[] = [...CAPABILITY_BANS, ...VISUALIZATION_BANS];

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
      for (const ban of [...TREE_BANS, ...NATIVE_BANS]) {
        if (ban.pattern.test(name)) failures.push(`${relPath} 的 ${field} 里声明了 ${name}：${ban.reason}`);
      }
      // 画布例外的边界①：核准只给渲染层。主进程/流水线里冒出一只画布库，就是把视图依赖塞进装机闭包。
      if (CANVAS_APPROVED_SET.has(name) && relPath !== 'packages/renderer/package.json') {
        failures.push(
          `${relPath} 的 ${field} 里声明了 ${name}：画布库只许渲染层声明（spec 5.10-16 / plan §7.8.2 裁定六）`,
        );
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

/**
 * 从锁文件的 `snapshots:` 段读包与包之间的依赖边。
 *
 * 只读这一段是因为它是唯一描述**包与包**关系的部分：`importers:` 描述的是 workspace 的直接声明
 * （那一层由 `checkManifest` 对着 package.json 判，更权威），`packages:` 段只有版本与完整性。
 * 行的形状是固定的：两级缩进是包键，六级缩进是它 `dependencies` / `optionalDependencies` 里的条目。
 * @param lockText `pnpm-lock.yaml` 全文
 * @returns 两张互为反向的邻接表（父→子 与 子→父），供可达性计算与"来源核对"分别使用
 */
function lockSnapshotEdges(lockText: string): {
  childrenByParent: Map<string, Set<string>>;
  parentsByChild: Map<string, Set<string>>;
} {
  const childrenByParent = new Map<string, Set<string>>();
  const parentsByChild = new Map<string, Set<string>>();
  const snapshotsAt = lockText.indexOf('\nsnapshots:\n');
  if (snapshotsAt < 0) return { childrenByParent, parentsByChild };
  let parent = '';
  for (const line of lockText.slice(snapshotsAt).split('\n')) {
    const header = /^ {2}'?([^':\s]+)'?:\s*$/.exec(line);
    if (header?.[1]) {
      parent = nameOfLockKey(header[1]);
      continue;
    }
    const dependency = /^ {6}'?([^':\s]+)'?:/.exec(line);
    const child = dependency?.[1];
    if (!parent || !child) continue;
    const children = childrenByParent.get(parent) ?? new Set<string>();
    children.add(child);
    childrenByParent.set(parent, children);
    const parents = parentsByChild.get(child) ?? new Set<string>();
    parents.add(parent);
    parentsByChild.set(child, parents);
  }
  return { childrenByParent, parentsByChild };
}

/**
 * 算出「只由画布族带进来的」图表禁令包名（spec 5.10-01 例外的实际边界）。
 *
 * 两步，缺一步都会漏：
 * 1. **可达性**：从 `CANVAS_APPROVED` 沿依赖边正向走，得到的集合之外一律不放行——否则两个与画布无关的
 *    被禁包互相依赖就能把自己"供"出来。
 * 2. **来源核对（最大不动点）**：可达集合里命中图表禁令的包名先全列为候选，再反复剔除「存在一条父边
 *    既不属画布族、也不在候选里」的名字。用剔除式而不是加入式，是因为 `@types/d3-*` 之间有真实的环
 *    （`@types/d3-zoom` ↔ `@types/d3-selection`），加入式的最小不动点会卡在空集上、把整条链判失败。
 * 只查图表类禁令：向量库 / 非内置 SQLite 那一类能力禁令不存在"由画布带进来"的例外。
 * @param lockText 锁文件全文
 * @param lockNames 锁文件里出现过的全部包名
 * @returns 可放行的画布传递链包名集合
 */
function canvasTransitiveBans(lockText: string, lockNames: ReadonlySet<string>): Set<string> {
  const { childrenByParent, parentsByChild } = lockSnapshotEdges(lockText);
  const reachable = new Set<string>();
  const queue: string[] = [...CANVAS_APPROVED];
  while (queue.length > 0) {
    const name = queue.shift() ?? '';
    if (reachable.has(name)) continue;
    reachable.add(name);
    for (const child of childrenByParent.get(name) ?? []) queue.push(child);
  }
  const candidates = new Set<string>();
  for (const name of lockNames) {
    if (reachable.has(name) && banOf(name, VISUALIZATION_BANS)) candidates.add(name);
  }
  for (;;) {
    let shrank = false;
    for (const name of [...candidates]) {
      const parents = parentsByChild.get(name);
      const hasForeignParent =
        !parents ||
        parents.size === 0 ||
        [...parents].some((parent) => !CANVAS_APPROVED_SET.has(parent) && !candidates.has(parent));
      if (!hasForeignParent) continue;
      candidates.delete(name);
      shrank = true;
    }
    if (!shrank) return candidates;
  }
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
/** 画布带进来的图表类传递链（放行的只有这一类，且以"父边全在画布族"为条件）。 */
const canvasTolerated = canvasTransitiveBans(lockText, lockNames);
for (const name of lockNames) {
  const banned = banOf(name, TREE_BANS);
  if (banned) {
    // 边界②：命中禁令但来源只有画布族 → 记为放行，交给结尾那条汇总行说清"机检看见了、是有意放过"。
    if (canvasTolerated.has(name)) continue;
    failures.push(`pnpm-lock.yaml 的依赖树里解析出 ${name}：${banned.reason}`);
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
  const runtimeBan = banOf(dep.name, [...TREE_BANS, ...NATIVE_BANS]);
  if (runtimeBan) {
    failures.push(
      `装机依赖闭包里有 ${dep.name}@${dep.version}：它本不该出现在运行期外置依赖里（spec 4.3-05 / 06、5.8-06）——${runtimeBan.reason}`,
    );
  }
  // 边界③：画布例外是给渲染层 bundle 的，不是给外置运行期依赖的。它出现在这里说明打包接线被改坏了。
  if (CANVAS_APPROVED_SET.has(dep.name)) {
    failures.push(
      `装机依赖闭包里有画布库 ${dep.name}@${dep.version}：画布属渲染层、由 Vite 打进 bundle，不得成为外置运行期依赖（spec 5.10-16）`,
    );
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
  console.error('✖ 离线依赖门槛机检未通过（spec 4.3-05 无外部向量服务 / 4.3-06 无本机编译扩展 / 5.8-06 无图表库）：');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(
  `✔ 离线依赖门槛机检通过（${String(manifestsScanned)} 份 package.json + 锁文件 ${String(lockNames.size)} 个包名 + ` +
    `${String(runtimeDeps.length)} 个装机依赖共 ${String(runtimeFilesScanned)} 个文件：` +
    '无外来向量库/向量服务/docker 客户端、无非内置 SQLite 绑定、无图表与图形引擎、装机闭包内无原生二进制与安装期编译脚本）',
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
if (canvasTolerated.size > 0) {
  // 同一条口径：放行不等于看不见。这里把画布带进来的整条 d3 链报出来，下一个人能一眼看出例外有多大。
  const toleratedNames = [...canvasTolerated].sort((left, right) => left.localeCompare(right));
  console.log(
    `  · 锁文件里有 ${String(canvasTolerated.size)} 个图表类包名（${toleratedNames.join('、')}）：` +
      `逐条核对过父边，全部只由 ${CANVAS_APPROVED.join(' / ')} 带进来，按 spec 5.10-01 的画布例外放行 —— ` +
      '任何 workspace 直接声明它们、或它们进了装机运行期闭包，都仍旧判失败。',
  );
}
