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
/**
 * 去掉注释后再做 class 串的判定（与 `check-dashboard-readonly.ts` 同一口径）：
 * 本项目的注释里就会写"不许再用裸 input""不许再拼 bg-*-wash"这类话，不去注释等于自己判自己。
 * 先去块注释（含 JSX 的 `{/* … *\/}`，它常常跨行），再整行丢掉行注释。
 * @param source 源文件原文
 * @returns 只留代码行的文本（下面两条禁令都以它为射程）
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/**
 * 与 `stripComments` 同一口径的去注释，但**保留行号**（第 13 节②的报错必须指得准：
 * 直接复用 `stripComments` 会把整片注释行删掉，报出来的行号就飘到别的元素上——探针实测过一次，
 * 注入在第 82 行、报在第 54 行）。跨行的块注释按空行处理，行注释只在**整行**以 `//` 开头时切，
 * 免得把字符串里的 `https://` 一起吃掉。
 * @param source 源文件原文
 * @returns 与原文行数一一对应的代码行数组
 */
function commentBlanked(source: string): string[] {
  let inBlock = false;
  return source.split(/\r?\n/).map((rawLine) => {
    let line = rawLine;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end < 0) return '';
      inBlock = false;
      line = line.slice(end + 2);
    }
    for (;;) {
      const start = line.indexOf('/*');
      if (start < 0) break;
      const close = line.indexOf('*/', start + 2);
      if (close < 0) {
        inBlock = true;
        line = line.slice(0, start);
        break;
      }
      line = line.slice(0, start) + line.slice(close + 2);
    }
    return line.trimStart().startsWith('//') ? '' : line;
  });
}

const RAW_CONTROL_TAGS = ['button', 'input', 'select', 'textarea'] as const;
const uiDir = path.join(rendererRoot, 'ui');
for (const file of tsxFiles) {
  // 原件目录**整棵子树**豁免（不是只豁免平铺的一层）：原件以后按形态分子目录，不该顺手把禁令解开。
  if (!path.relative(uiDir, file).startsWith('..')) continue;
  const code = stripComments(await readFile(file, 'utf8'));
  for (const tag of RAW_CONTROL_TAGS) {
    const count = (code.match(new RegExp(`<(?:${tag})[\\s/>]`, 'g')) ?? []).length;
    if (count > 0) {
      failures.push(
        `${path.relative(repoRoot, file)} 里有 ${String(count)} 只裸 <${tag}>：渲染层的控件只许出自 src/ui/** 原件（6.2-14）`,
      );
    }
  }
}

/**
 * 9. 语气洗底（`bg-*-wash`）只许出现在 `src/ui/**`（spec 6.2-20，第四十片）。
 *    这条等的从来不是写法，而是**归属先定完**：提示条（6.2-16/17/18）与芯片（6.2-19）收进原件之后，
 *    剩下的行/卡片/选中行按稿改成"语气只上描边、底材留墨面"（`shared.css:861-900`），
 *    全渲染层的 wash 字面量就只剩原件自己在读的那四档。此刻才写得出一句不留豁免清单的禁令：
 *    `globals.css` 里那 9 行是 `--color-*-wash` 的**令牌声明**，不带 `bg-` 前缀，天然不在射程里，
 *    而面板要表状态就交 `BannerTone` 档名去拼 `BLOCK_EDGE_CLASS` / `TAG_TONE_CLASS`（§2.5 的"一份事实一张脸"）。
 */
const TONE_WASH_PATTERN = /bg-(?:celadon|amber|seal|jade)-wash/g;
for (const file of tsxFiles) {
  if (!path.relative(uiDir, file).startsWith('..')) continue;
  const hits = stripComments(await readFile(file, 'utf8')).match(TONE_WASH_PATTERN);
  if (hits) {
    failures.push(
      `${path.relative(repoRoot, file)} 里有 ${String(hits.length)} 处 \`${hits[0]}\` 这类的语气洗底：` +
        'wash 只许由 src/ui/** 的原件持有，面板交语气档名（spec 6.2-20）',
    );
  }
}

/**
 * 11. 字号与灰阶档的配对纪律（spec 6.1-09 的灰阶半边）。
 *     6.1 第二十三片把"档位按字号分配"定成组织原则：**`slate-500`/`slate-600` 只属于 ≤11px 的读数**，
 *     ≥12px 的正文/说明文字只许 `slate-400` 及更深——因为毡案的灰阶是等比翻出来的，500 比 400 还浅，
 *     挂到 12px 正文上直接跌破 6.1-06 的 4.5:1 门槛（那轮普查失守 46/46 全在这一档）。
 *     判据落在**字符串字面量级**而不是行级：一个 `className` 串就是一个元素的 class 集，
 *     把 size 与 color 拆进不同串（如 `stepStatusStyle` 交色、消费者给 `text-[11px]`）不误报，
 *     代价是跨串配对看不见——那属于"某处把 slate-500 与 text-xs 写进了同一格"这一类回归，正是这条要拦的。
 *     色相档的 ≥12px 半边按第四十二片的裁定落在**下一节**（令牌层），不在这一节：原件的字号与颜色
 *     分在两个常量里（`BANNER_SIZE.full` 给 12px、`BANNER_CLASS` 给色），字符串级判据看不见那对配对。
 */
const SIZE_PX: Record<string, number> = {
  'text-xs': 12,
  'text-sm': 14,
  'text-base': 16,
  'text-lg': 18,
  'text-xl': 20,
  'text-2xl': 24,
  'text-3xl': 30,
};
const ARB_SIZE_PATTERN = /\btext-\[(\d+(?:\.\d+)?)px\]/g;
const SMALL_GRAY_PATTERN = /\btext-slate-[56]00\b/;

/** 抽出一段源码里的所有字符串字面量内容（单/双引号不跨行，反引号可跨行）。 */
function stringLiterals(src: string): string[] {
  const out: string[] = [];
  const re = /"([^"\n]*)"|'([^'\n]*)'|`([\s\S]*?)`/g;
  for (let m = re.exec(src); m; m = re.exec(src)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

/** 一个 class 串里出现的最小字号（像素）；没有显式字号返回 null（继承来的看不见，不误判）。 */
function largestPx(cls: string): number | null {
  let max: number | null = null;
  for (const [token, px] of Object.entries(SIZE_PX)) {
    if (new RegExp(`(^|\\s)${token}(\\s|$)`).test(cls)) max = max === null ? px : Math.max(max, px);
  }
  for (let m = ARB_SIZE_PATTERN.exec(cls); m; m = ARB_SIZE_PATTERN.exec(cls)) {
    const px = Number.parseFloat(m[1]);
    max = max === null ? px : Math.max(max, px);
  }
  ARB_SIZE_PATTERN.lastIndex = 0;
  return max;
}

for (const file of tsxFiles) {
  const code = stripComments(await readFile(file, 'utf8'));
  for (const cls of stringLiterals(code)) {
    const px = largestPx(cls);
    if (px !== null && px >= 12 && SMALL_GRAY_PATTERN.test(cls)) {
      failures.push(
        `${path.relative(repoRoot, file)} 里有一格 ${String(px)}px 文案挂了 slate-500/600：` +
          '灰阶 500/600 只属于 ≤11px 读数，≥12px 用 slate-400 及更深（spec 6.1-09）',
      );
    }
  }
}

/**
 * 12. 语气色当文字用必须过 AA（spec 6.1-09 的色相半边，第四十二片按 2026-10-08 裁定
 *     「令牌层再压深毡案语气色」落地）。
 *     判据放在**令牌层**而不是消费层，有两个理由：
 *     ① 原件把字号与颜色分在两个常量里（`BANNER_SIZE.full` 给 12px、`BANNER_CLASS` 给色），
 *        第 11 节那种"同一个 class 串里配对"的字符串级判据看不见这一对，写出来只会误报或漏报；
 *     ② 裁定要的是"一处改、全族受益"——只要每档的**文字档** `--color-<tone>-ink` 压在自己的淡洗上、
 *        对该主题最浅的一级面板也过 4.5，那么引用它的每一只载体（`Banner`/`Tag`/`EffectChip`/
 *        按钮结果态/风险档选中键）都跟着过，消费侧永远只有一条写法，不需要按主题分支。
 *     同一节还钉住两条令牌纪律：四档在两案里都必须有 `-ink`（缺键=那一档当文字用没人管），
 *     以及 `--color-<tone>-wash` 的 rgb 必须与 `--color-<tone>` 同色（`globals.css` 里那条
 *     「wash 的 rgb 必须跟着各自 token 走」——改了色相档忘了淡洗，材质语言就失配，且肉眼难查）。
 */
const TONE_NAMES = ['celadon', 'jade', 'amber', 'seal'] as const;
/** 语气载体可能落上的承载面：桌面与导航用 950/900、区块用 850、选中与悬停用 800、中性长条与底栏用 750
 *  （750 在这一族里不是纯中性面：活体普查实测到一格 11px 琥珀文案压在 ink-750 上的自家 wash 里，
 *  读数 4.18 —— 所以它是最差的那一面，必须进判据。见 docs/acceptance/06-ui-ink-desk/6.1-09-tone-token-readings.txt）。 */
const PANEL_INK_NAMES = ['ink-750', 'ink-950', 'ink-900', 'ink-850', 'ink-800'] as const;
/** 除自家淡洗之外，语义按钮三档还把同色实底压到 14%/18%（`controls.tsx:57-61`），
 *  文字档在这些底上同样必须过 AA——不然"改令牌一次受益全族"这句话就只兑现了一半。
 *  青瓷没有按钮档（那一族只有 jade/amber/seal 三档语义按钮），所以不在表里。 */
const SOLID_TONE_ALPHA: Record<(typeof TONE_NAMES)[number], number | null> = {
  celadon: null,
  jade: 0.14,
  amber: 0.14,
  seal: 0.18,
};
const AA_NORMAL_TEXT = 4.5;

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** 把一个 CSS 颜色字面量（`#rrggbb` 或 `rgba(r, g, b, a)`）解析成 rgba；解析不出返回 null。 */
function parseCssColor(value: string): Rgba | null {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    const body = hex[1];
    return {
      r: Number.parseInt(body.slice(0, 2), 16),
      g: Number.parseInt(body.slice(2, 4), 16),
      b: Number.parseInt(body.slice(4, 6), 16),
      a: 1,
    };
  }
  const fn = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[,/\s]+([\d.]+))?\s*\)$/i.exec(value.trim());
  if (fn) return { r: Number(fn[1]), g: Number(fn[2]), b: Number(fn[3]), a: fn[4] === undefined ? 1 : Number(fn[4]) };
  return null;
}

/** WCAG 相对亮度。 */
function relativeLuminance(c: Rgba): number {
  const channel = (v: number) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/** WCAG 对比度（1 = 完全不可分辨）。 */
function contrastRatio(fore: Rgba, back: Rgba): number {
  const a = relativeLuminance(fore);
  const b = relativeLuminance(back);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** 半透明色压在**不透明**底上得到的合成色（淡洗就是这么读的）。 */
function compositeOn(overlay: Rgba, backdrop: Rgba): Rgba {
  return {
    r: overlay.r * overlay.a + backdrop.r * (1 - overlay.a),
    g: overlay.g * overlay.a + backdrop.g * (1 - overlay.a),
    b: overlay.b * overlay.a + backdrop.b * (1 - overlay.a),
    a: 1,
  };
}

/** 取一段 CSS 文本里 `--color-<名>: <值>;` 的声明表（同名取先出现的那条）。 */
function colorTokenTable(css: string): Map<string, string> {
  const table = new Map<string, string>();
  const re = /--color-([a-z0-9-]+)\s*:\s*([^;]+);/g;
  for (let m = re.exec(css); m; m = re.exec(css)) if (!table.has(m[1])) table.set(m[1], m[2].trim());
  return table;
}

const globalsSource = await readFile(path.join(rendererRoot, 'globals.css'), 'utf8');
// 只认**选择器行**上那一次出现：文件顶部的说明注释里也提到 `[data-theme='light']`，
// 用 indexOf 会把墨案块切在注释中间，读到一个空表。
const lightBlockStart = globalsSource.search(/^\[data-theme='light'\]\s*\{/m);
if (lightBlockStart < 0) {
  failures.push(
    "globals.css 里找不到 `[data-theme='light']` 那一块：毡案令牌读不到了，第 12 节无法核验（spec 6.1-09）",
  );
} else {
  for (const [案名, block] of [
    ['墨案', globalsSource.slice(0, lightBlockStart)],
    ['毡案', globalsSource.slice(lightBlockStart)],
  ] as const) {
    const tokens = colorTokenTable(block);
    const panels = PANEL_INK_NAMES.map((name) => parseCssColor(tokens.get(name) ?? ''));
    if (panels.some((p) => p === null)) {
      failures.push(`globals.css 的${案名}块里读不到面板面色阶（${PANEL_INK_NAMES.join('/')}），第 12 节无法核验`);
      continue;
    }
    for (const tone of TONE_NAMES) {
      const hue = parseCssColor(tokens.get(tone) ?? '');
      const textTier = parseCssColor(tokens.get(`${tone}-ink`) ?? '');
      const wash = parseCssColor(tokens.get(`${tone}-wash`) ?? '');
      if (!hue) {
        failures.push(`globals.css 的${案名}块缺 --color-${tone}（色相档）`);
        continue;
      }
      if (!textTier) {
        failures.push(
          `globals.css 的${案名}块缺 --color-${tone}-ink：语气档的文字档没声明，` +
            '组件侧就只有色相档可挂，而色相档压在自己淡洗上过不了 AA（spec 6.1-09）',
        );
        continue;
      }
      if (!wash) {
        failures.push(`globals.css 的${案名}块缺 --color-${tone}-wash`);
        continue;
      }
      if (hue.r !== wash.r || hue.g !== wash.g || hue.b !== wash.b) {
        failures.push(
          `globals.css 的${案名} --color-${tone}-wash 的 rgb 是 rgba(${String(wash.r)}, ${String(wash.g)}, ${String(wash.b)})，` +
            `与 --color-${tone}（${[hue.r, hue.g, hue.b].join(', ')}）不同色：淡洗必须跟着色相档走，否则「底色是这一色相的淡洗」失配`,
        );
      }
      const solid = SOLID_TONE_ALPHA[tone];
      const backdrops = [
        { label: '自家淡洗', alpha: wash.a },
        ...(solid === null ? [] : [{ label: '语义按钮的同色实底', alpha: solid }]),
      ];
      for (const back of backdrops) {
        const worst = Math.min(
          ...(panels as Rgba[]).map((panel) => contrastRatio(textTier, compositeOn({ ...hue, a: back.alpha }, panel))),
        );
        if (worst < AA_NORMAL_TEXT) {
          failures.push(
            `${案名}的 ${tone} 文字档压在${back.label}（${String(Math.round(back.alpha * 100))}%）上，` +
              `对五级承载面里最差的那一面只有 ${worst.toFixed(2)}:1（门槛 ${String(AA_NORMAL_TEXT)}:1）：` +
              '语气档当文字用的载体（Banner/Tag/EffectChip/按钮结果态）全都吃这一档，改令牌层而不是逐点打补丁（spec 6.1-09）',
          );
        }
      }
    }
  }
}

/**
 * 13. hover 只许长在"这一格真能点"上（spec 6.2-25，07 稿第 199 行那条硬规矩：
 *     「不可点的元素绝不长出 hover（效果芯片、标签、读数都不响应鼠标）」）。两条判据各拦一种回归：
 *     ① 同格共存：一个 class 串（=一只元素的 class 集）里既给 `hover:` 又给按不动画法（`opacity-40` /
 *        `cursor-not-allowed`），就是「按不动却会提亮」。07 稿对 seal 档写的"未签字/额度用尽时 hover 完全
 *        无效"与 6.2-10 在 `DeskButton` 上钉的那条是同一件事，而原件层这次普查又在 `DeskSegmented` 抓到第二处
 *        （在途整组走 `aria-disabled`，`:hover` 照样生效）——所以判据要求两态的画法**分属两条字面量**。
 *     ② 面板层（`src/ui/**` 之外）的 hover 必须与一张交互凭据同格。面板给读数/标签/行底挂 hover 是最顺手的
 *        一种"界面说谎"：看着可点，点了什么都没有。凭据按本项目既有口径取——`data-action`（§9 第④条：
 *        每只可点控件都要有）、鼠标/键盘处理器、`draggable`，以及 `cursor-pointer`/`cursor-grab` 这两档光标承诺。
 *     判据 ② 是**行窗口级**而不是 JSX 元素级：拿 hover 那一行上下各 10 行找凭据。代价写清楚——相邻元素自带
 *     凭据时会误放行（窗口不等于元素边界），但"给一只静态读数挂 hover"必红，正是这条要拦的方向。
 *     `--xy-controls-button-background-color-hover` 这类第三方 CSS 变量名不在射程里：`hover:` 前面没有空白，
 *     而它本来就是 react-flow 自己那颗 `<Controls>` 按钮的悬停色（不是面板手写的悬停画法）。
 */
const HOVER_PATTERN = /(?:^|\s)hover:/;
const DEAD_CLASS_PATTERN = /(?:^|\s)(?:opacity-40|cursor-not-allowed)(?:\s|$)/;
const INTERACTIVE_CREDENTIAL =
  /(?:^|[\s{<])(?:data-action|action=|onClick|onDoubleClick|onPointerDown|onKeyDown|draggable|cursor-pointer|cursor-grab)(?:$|[\s=:>"'{])/;

for (const file of tsxFiles) {
  const code = stripComments(await readFile(file, 'utf8'));
  for (const cls of stringLiterals(code)) {
    if (HOVER_PATTERN.test(cls) && DEAD_CLASS_PATTERN.test(cls)) {
      failures.push(
        `${path.relative(repoRoot, file)} 里有一格同时给了 hover 与按不动画法：` +
          '「不可点的元素绝不长出 hover」，两态的画法必须分属两条字面量（spec 6.2-25）',
      );
    }
  }
}

for (const file of tsxFiles) {
  // 原件层豁免这一条，与 §10 的 6.2-14 是同一条豁免逻辑：可交互控件本来就只长在 `src/ui/**`，
  // 那里的 hover 归判据 ① 与各原件自己的档位表管；面板要悬停就得把那一格交给原件。
  if (!path.relative(uiDir, file).startsWith('..')) continue;
  const lines = commentBlanked(await readFile(file, 'utf8'));
  lines.forEach((line, index) => {
    if (!HOVER_PATTERN.test(line)) return;
    const neighbourhood = lines.slice(Math.max(0, index - 10), index + 11).join('\n');
    if (!INTERACTIVE_CREDENTIAL.test(neighbourhood)) {
      failures.push(
        `${path.relative(repoRoot, file)}:${String(index + 1)} 有一格长不出交互凭据却挂了 hover：` +
          '面板的悬停只许出现在带 `data-action`／事件处理器／`draggable`／指针光标的那一格上（spec 6.2-25）',
      );
    }
  });
}

if (failures.length) {
  console.error('✖ 渲染层规范检查未通过：');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(
  `✔ 渲染层规范检查通过（${String(localeNames.length)} 个语言包，${String(tsxFiles.length)} 个源文件，派生文案 ${String(derivedKeys.size)} 条逐包齐备；` +
    'src/ui/** 之外裸原生控件 0 只、语气洗底 0 处、≥12px 灰阶档 0 处、hover 挂到不可点那一格 0 处，' +
    '四档语气文字档 × 两案 × 五级承载面 × 两种同色底全部 ≥4.5:1）',
);
