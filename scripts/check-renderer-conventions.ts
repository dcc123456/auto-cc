/**
 * 渲染层规范机检（AGENTS.md §5.1/§5.3/§5.5/§5.6，spec 1.2-13…1.2-16）。
 *
 * eslint 负责逐文件拦截（内联 style、自制 svg、裸中文、非入口样式），
 * 这个脚本负责跨文件一致性：样式文件白名单、语言包 key 对齐、代码里用到的 i18n key 是否真的存在
 * （含占位符实参齐不齐）、**描述表点名的派生文案**是否每份语言包都有、内核视图宽度两侧是否同源、工作流进度的状态源与消费者。
 * 编号与各条判据一一对应，新增一条只在文件末尾追加一节，别把已有的类别计数写进注释（它会过期）。
 * 任一不符即 exit 1，因此挂在 `pnpm lint` 上是硬门禁而不是提示。
 */
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { WORKFLOW_GRAPH_CHECK_CODES } from '../packages/core/src/graph-check.js';
import { WORKFLOW_OPERATORS, operatorParamFields } from '../packages/core/src/operators.js';
import { WORKFLOW_PLANS } from '../packages/workflow/src/plan.js';

const repoRoot = path.resolve(import.meta.dirname, '..');
const rendererRoot = path.join(repoRoot, 'packages', 'renderer', 'src');
const localesDir = path.join(rendererRoot, 'locales');
const allowedCss = ['globals.css'];

const failures: string[] = [];

/** 把嵌套 JSON 展平成 `a.b.c` 形式的 key 列表。 */
function flatten(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return prefix ? [prefix] : [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flatten(child, prefix ? `${prefix}.${key}` : key),
  );
}

/** 把嵌套 JSON 展平成 `[key, 文案]`；只收字符串叶子，占位符要按文案原文比对。 */
function flattenValues(value: unknown, prefix = ''): [string, string][] {
  if (typeof value === 'string') return prefix ? [[prefix, value]] : [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flattenValues(child, prefix ? `${prefix}.${key}` : key),
  );
}

async function files(dir: string, matcher: (name: string) => boolean): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await files(full, matcher)));
    else if (matcher(entry.name)) found.push(full);
  }
  return found;
}

// 1) 样式文件只允许入口 globals.css（1.2-13）
const cssFiles = await files(rendererRoot, (name) => name.endsWith('.css'));
for (const file of cssFiles) {
  if (!allowedCss.includes(path.basename(file))) {
    failures.push(`样式文件只允许入口 globals.css，发现 ${path.relative(repoRoot, file)}`);
  }
}

// 2) 语言包 key 必须完全对齐，缺失即失败（1.2-16）；以 zh-CN 为基准，报错才指得清是谁缺。
const localeNames = (await readdir(localesDir)).filter((name) => name.endsWith('.json')).sort();
const localeKeys = new Map<string, string[]>();
for (const name of localeNames) {
  const json = JSON.parse(await readFile(path.join(localesDir, name), 'utf8')) as unknown;
  localeKeys.set(name, flatten(json).sort());
}
const reference = localeNames.includes('zh-CN.json') ? 'zh-CN.json' : localeNames[0];
if (!reference) failures.push('locales 目录下一个语言包都没有');
for (const name of localeNames) {
  if (!reference || name === reference) continue;
  const expected = new Set(localeKeys.get(reference));
  const actual = new Set(localeKeys.get(name) ?? []);
  const missing = [...expected].filter((key) => !actual.has(key));
  const extra = [...actual].filter((key) => !expected.has(key));
  if (missing.length) failures.push(`${name} 缺少 key：${missing.join(', ')}`);
  if (extra.length) failures.push(`${name} 多出 key：${extra.join(', ')}`);
}

// 3) 代码里引用的 i18n key 必须在语言包里存在（防拼写漂移），
//    且文案里的每个 `{{占位符}}` 都必须有调用点实参 —— 漏一个就把 `{{action}}` 原样画到界面上。
//    i18next 的 `t('title')` 在 defaultNS 下解析为 `shell.title`，因此允许两种写法。
const zhKeys = new Set(localeKeys.get('zh-CN.json') ?? []);
const resolvableKeys = new Set<string>(zhKeys);
const zhValues = JSON.parse(await readFile(path.join(localesDir, 'zh-CN.json'), 'utf8')) as unknown;
const valuesByKey = new Map<string, string>();
for (const [key, value] of flattenValues(zhValues)) {
  valuesByKey.set(key, value);
  const [, ...rest] = key.split('.');
  if (rest.length) valuesByKey.set(rest.join('.'), value);
  if (rest.length) resolvableKeys.add(rest.join('.'));
}
const tsxFiles = await files(rendererRoot, (name) => /\.(tsx|ts)$/.test(name));
for (const file of tsxFiles) {
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(/\bt\(\s*'([^']+)'((?:[^()]|\([^()]*\))*)\)/g)) {
    const key = match[1] ?? '';
    if (!resolvableKeys.has(key)) {
      failures.push(`${path.relative(repoRoot, file)} 引用了不存在的 i18n key：${key}`);
      continue;
    }
    // 实参名从第二个实参的对象字面量里取：既认 `action: x`，也认 `{ action }` 这种简写。
    const argObject = (match[2] ?? '').replace(/^\s*,\s*/, '').trim();
    const objectBody = argObject.startsWith('{') ? argObject.slice(1, -1) : '';
    const argNames = new Set(
      objectBody
        .split(',')
        .map((entry) => /^\s*([A-Za-z_$][\w$]*)\s*(:|$)/.exec(entry)?.[1])
        .filter((name): name is string => Boolean(name)),
    );
    for (const placeholder of valuesByKey.get(key)?.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g) ?? []) {
      if (placeholder && !argNames.has(placeholder[1] ?? '')) {
        failures.push(`${path.relative(repoRoot, file)} 调用 t('${key}') 未传占位符 {{${placeholder[1]}}}`);
      }
    }
  }
}

// 4) 内核视图宽度两侧同源（1.2-12）
const bridgeSource = await readFile(path.join(repoRoot, 'packages', 'shared', 'src', 'bridge.ts'), 'utf8');
const cssSource = await readFile(path.join(rendererRoot, 'globals.css'), 'utf8');
const ratio = Number(/KERNEL_VIEW_WIDTH_RATIO\s*=\s*([\d.]+)/.exec(bridgeSource)?.[1]);
const cssPercent = Number(/--kernel-view-width:\s*([\d.]+)%/.exec(cssSource)?.[1]);
if (!Number.isFinite(ratio) || !Number.isFinite(cssPercent)) {
  failures.push('无法解析内核视图宽度：KERNEL_VIEW_WIDTH_RATIO 或 --kernel-view-width 缺失');
} else if (Math.abs(ratio * 100 - cssPercent) > 0.001) {
  failures.push(`内核视图宽度不一致：主进程 ${String(ratio * 100)}% ≠ 渲染层 ${String(cssPercent)}%`);
}

// 5) 工作流运行状态的来源唯一（spec 2.8-12）+ 进度靠事件而非轮询（spec 2.8-02）
//    这两条在 2.8-a 之前是靠人工读代码确认的，本片按 plan §15.8 落点 4 把它们变成机检：
//    `workflow.runner.current()` 的调用点必须只有一个（`useWorkflowRun`），两个视图都从它取数；
//    任何文件都不许在定时器里读 workflow 服务——那会把「事件流驱动」退化成轮询的变体。
const runStateReaders: string[] = [];
/** 从 `useWorkflowRun` 取进度的那些视图（下面第 6 条要按文件判，这里只收集事实不做判断）。 */
const workflowHookUsers = new Set<string>();
for (const file of tsxFiles) {
  const source = await readFile(file, 'utf8');
  if (/workflow\['runner\.current'\]/.test(source)) runStateReaders.push(path.relative(repoRoot, file));
  if (/setInterval[\s\S]*workflow\[/.test(source)) {
    failures.push(
      `${path.relative(repoRoot, file)} 在定时器里读 workflow 服务，进度必须由 workflow/progress 事件驱动（2.8-02）`,
    );
  }
  if (/from '\.\/useWorkflowRun'/.test(source)) workflowHookUsers.add(path.basename(file));
}
if (runStateReaders.join(',') !== path.relative(repoRoot, path.join(rendererRoot, 'useWorkflowRun.ts'))) {
  failures.push(
    `workflow.runner.current() 的调用点应唯一在 useWorkflowRun.ts，实际见：${runStateReaders.join(', ') || '（无）'}`,
  );
}

// 6) 同一次运行的进度必须两处都在（spec 5.4-07 的静态半边）
//    对话流与工作流面板是同一份读数的两个用户：谁都不许绕过那口订阅自己读服务（第 5 条已经拦住了
//    「自己调 current()」和「定时器轮询」两种偏法），但**少一个用户**是第 5 条查不出来的静默回归——
//    表现恰好是"对话里看不见进度"，也就是这条验收原本要防的事。
for (const required of ['ChatPanel.tsx', 'WorkflowPanel.tsx']) {
  if (!workflowHookUsers.has(required)) {
    failures.push(`${required} 不再从 ./useWorkflowRun 取进度，双入口同步（5.4-07）断了一处`);
  }
}

// 7) 画布的运行态只许由事件推给它（spec 5.10-11 的机检半边）
//    第 5 条管的是"整个渲染层不许在定时器里读 workflow"，这一条把判据收到画布自己身上：
//    `WorkflowCanvas.tsx` 里不许有 setInterval，也不许自己调 runner 的读数口——格子状态必须是父层
//    从 workflow/progress 推来的那份 steps。画布一自己读，同一份运行态就有了第二个真相（§2.5），
//    而它读到的那一刻和事件推来的那一刻谁的相位更新，界面上看不出来。
const canvasSource = await readFile(path.join(rendererRoot, 'WorkflowCanvas.tsx'), 'utf8');
if (/setInterval/.test(canvasSource)) {
  failures.push('WorkflowCanvas.tsx 里有 setInterval：画布进度只能由 workflow/progress 事件推（5.10-11）');
}
for (const reader of ['runner.current', 'runner.state', 'runner.resumable']) {
  const pattern = new RegExp(`workflow\\['${reader.replace('.', '\\.')}'\\]`);
  if (pattern.test(canvasSource)) {
    failures.push(`WorkflowCanvas.tsx 自己调了 ${reader}()：运行态读数必须由父层传入（5.10-11）`);
  }
}

// 8) Automa 移植面零复制（spec 5.10-15）
//    源仓库 browser-copilot 的编辑器是 Automa（AGPL v3，第三方版权，用户给的豁免覆盖不到）的 React 移植：
//    61 只 Edit*.tsx + drawflow 那套数据格式。plan §5.10 的选型表因此只允许 clean-room 重写语义。
//    这条闸门防的是"哪天顺手把那些文件搬过来"：文件名与格式标识符都不许出现在源码里。
//    只扫 packages/*/src（文档与 research 里提到 drawflow 是取证，不算复制）。
const automaRoots = (await readdir(path.join(repoRoot, 'packages'), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(repoRoot, 'packages', entry.name, 'src'))
  .filter((dir) => existsSync(dir));
const automaFiles = (await Promise.all(automaRoots.map((dir) => files(dir, () => true)))).flat();
for (const file of automaFiles) {
  if (/^Edit.*\.tsx$/.test(path.basename(file))) {
    failures.push(
      `发现 Automa 编辑器同名的移植文件 ${path.relative(repoRoot, file)}：移植面只许 clean-room 重写（5.10-15）`,
    );
  }
  const source = await readFile(file, 'utf8');
  if (/drawflow/i.test(source)) {
    failures.push(`${path.relative(repoRoot, file)} 里出现 drawflow 标识符：那是 Automa（AGPL）的数据格式（5.10-15）`);
  }
}

// 9) 描述表点名的派生文案必须在**每份**语言包里都有（spec 5.10-16 的全表半边）
//    第 3 条只能扫代码里写死的 `t('...')`，而画布有一整类文案是现算出来的键：
//    `workflow.operator.<kind>.title`、`workflow.param.<kind>.<field>`、`workflow.canvas.issue.<code>`、
//    `workflow.step.<nodeId>`——它们的字面量不在代码里，加一只算子 / 一条校验码 / 一格节点就静默漏一条，
//    表现是界面上原样画出 `deliver-1001` 这种 id（5.10-16 走查时正是这么抓到的）。
//    判据按描述表与计划目录这两份事实源现算，所以它不需要维护第二份清单（§2.5）。
const derivedKeys = new Set<string>();
for (const descriptor of WORKFLOW_OPERATORS) {
  derivedKeys.add(descriptor.titleKey);
  derivedKeys.add(`workflow.operator.category.${descriptor.category}`);
  derivedKeys.add(`workflow.operator.effect.${descriptor.effect}`);
  for (const field of operatorParamFields(descriptor.params))
    derivedKeys.add(`workflow.param.${descriptor.kind}.${field.name}`);
}
for (const code of WORKFLOW_GRAPH_CHECK_CODES) derivedKeys.add(`workflow.canvas.issue.${code}`);
for (const plan of Object.values(WORKFLOW_PLANS)) {
  for (const node of plan.nodes) derivedKeys.add(`workflow.step.${node.id}`);
}
for (const name of localeNames) {
  // 语言包的根就是 i18next 的默认命名空间（`i18n.ts` 的 `ns: ['shell']`），代码里的键不带这一层。
  const flat = new Set(localeKeys.get(name) ?? []);
  const missing = [...derivedKeys].filter((key) => !flat.has(key) && !flat.has(`shell.${key}`));
  if (missing.length) {
    failures.push(`${name} 缺派生文案 ${String(missing.length)} 条：${missing.sort().join(', ')}`);
  }
}

// 10) 渲染层只留一套 UI 基础设施：`src/ui/**` 之外不许有裸原生控件（spec 6.2-14 的机检半边）
//     按 2026-10-06 裁定，这条**等到 54 处全部迁完才写**（「全换完再上机检」+ 不留基线豁免清单）。
//     第三十二片把最后一处（对话输入区 composer）接进 `DeskTextarea` 之后，全渲染层的裸控件归零，
//     于是这一条从 `[纪律]` 升成 `[机检]`，从这片起不再有"某面板又长出一只手写 `<input>`"的余地。
//     判据是 C 类而不是跑出来的：裸控件在运行期没有任何负面信号——它照样能点、照样能输入，
//     只是那一格的描边/字号/焦点环由面板自己说了算，直到下一次令牌改档才集体露馅（6.2-10 正是这么爆的）。
//     第三方 chrome 不落在这一条射程里：画布的 `<Controls>` 是 react-flow 的**组件标签**，
//     不是原生 `<button>`，所以这条禁令天然不需要任何豁免名单（裁定原文要求的就是"不留基线豁免清单"）。
const RAW_CONTROL_TAGS = ['button', 'input', 'select', 'textarea'] as const;
const uiDir = path.join(rendererRoot, 'ui');
for (const file of tsxFiles) {
  // 原件目录**整棵子树**豁免（不是只豁免平铺的一层）：原件以后按形态分子目录，不该顺手把禁令解开。
  if (!path.relative(uiDir, file).startsWith('..')) continue;
  const raw = await readFile(file, 'utf8');
  // 注释不参与判定（与 `check-dashboard-readonly.ts` 同一口径）：本项目的注释会写"不许再用裸 input"这类话。
  // 先去块注释（含 JSX 的 `{/* … */}`，它常常跨行），再整行丢掉行注释。
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
  for (const tag of RAW_CONTROL_TAGS) {
    const count = (code.match(new RegExp(`<(?:${tag})[\\s/>]`, 'g')) ?? []).length;
    if (count > 0) {
      failures.push(
        `${path.relative(repoRoot, file)} 里有 ${String(count)} 只裸 <${tag}>：渲染层的控件只许出自 src/ui/** 原件（6.2-14）`,
      );
    }
  }
}

if (failures.length) {
  console.error('✖ 渲染层规范检查未通过：');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(
  `✔ 渲染层规范检查通过（${String(localeNames.length)} 个语言包，${String(tsxFiles.length)} 个源文件，派生文案 ${String(derivedKeys.size)} 条逐包齐备；` +
    `src/ui/** 之外裸原生控件 0 只）`,
);
