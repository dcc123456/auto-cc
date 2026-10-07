/**
 * 静态检查：**指标看板只读**，不许从看板发出任何动作（spec 5.8-02 的组件半边）。
 *
 * 判据原文是"看板为只读聚合视图，不提供任何动作按钮（不能从看板直接发外发请求）"。
 * 这条也是 C 类而不是跑出来的行为，原因与调度器那条（`check-scheduler-no-external-cron.ts`）同形：
 * "看板没有外发"在运行期没有正面信号——它本来就什么都不该发生，只能从代码形状上钉。
 * 而这里防的失效很具体：**看板长成控制台**。五级漏斗旁边加一只"重跑这轮"、额度块下面加一只
 * "再多打几个招呼"，在功能上都是"顺手补一个入口"，但那是把 `entitlement.gate` 之外的一条外发通道
 * 从界面侧开出来（§8.3 的频控与日上限靠的是"外发只有那几只手"，主计划 §1.4 的自动化必须走闸门）。
 * 服务半边（聚合口不装 store 也答得出、源码零 SQL、无 `inject`）已在 5.8-a 落进用例；
 * 这里补的是界面半边。
 *
 * 四条判据，各拦一种绕法：
 * 1. **进口只有四个包 + 一条 UI 原件相对路径**（`react` / `react-i18next` / `lucide-react` /
 *    `@auto-cc/shared` / `./ui/controls`）：引不到能力包就引不到第二条能力通道，这一条最硬，所以先判它。
 *    2026-10-07 用户裁定放开 `./ui/controls` 这一条（06-ui-ink-desk 第三十片的活体读数证明看板那几处
 *    手写的 class 与原件同源、换件不动画面），但**放开的只是这一条相对路径**，不是"引 UI 层没关系"：
 *    原件自己有没有偷偷开口子，由判据 5 直接检它本体。
 * 2. **桥接口只有一句 `funnel.query`**：`window.autoCC` 上是白名单生成的命名空间，
 *    看板只能碰 `funnel` 那一只，而且只调 `query`；出现别的命名空间或第二次调用点即失败。
 * 3. **没有任何网络与进程出口**：`fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource` /
 *    `sendBeacon` / `import()` / `require(` 一个都不许出现（渲染层本来就在 sandbox 里，
 *    这几条钉的是"别把口子开回来"）。
 * 4. **动作键只有一只、且它的 onClick 只是重读**：`<button` 与 `<DeskButton` 合计恰好一处，
 *    `onClick` 只允许 `void read()`。区间下拉与两个日期输入是筛选器不是动作按钮，所以按"按钮开标签"计数、
 *    不按"可交互元素"计数；换进原件之后 `<button` 这个字面量会消失，所以计数必须同时认得两种写法，
 *    否则判据会在"什么都没多出来"的那一次提交上假红。
 * 5. **被放开的进口自己也要被钉住**：`packages/renderer/src/ui/controls.tsx` 本体不许出现
 *    桥接口、网络出口或能力包进口——判据 1 放开的是一条"只画界面"的通道，
 *    如果哪天原件里长出了 `window.autoCC`，这条口子就不再是样式口了。
 *
 * 命令：`pnpm lint` 里倒数第二条，或单独 `tsx scripts/check-dashboard-readonly.ts`。
 * 注释行不参与判定（与调度器那条同一口径）：本项目的注释会写"不发一个动作"这类话。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '..');

/**
 * 看板的组件文件（判据 5.8-02 说的"看板"就是这个化身；`UsagePanel` 是 1.9 的账本表，不属本片）。
 *
 * 命令行的第一个实参可以换掉被检文件：反向验证要用一份**故意违规的副本**证明这四条判据真的会拦
 * （见 spec 5.8-c 落地记录），没有这个口就只能改真组件来做实验。
 */
const TARGETS = process.argv[2] === undefined ? ['packages/renderer/src/MetricsPanel.tsx'] : [process.argv[2]];

/** 允许的进口（模块说明符 → 为什么允许）。`./ui/controls` 是判据 5 单独钉住的样式口。 */
const ALLOWED_MODULES: readonly string[] = [
  'react',
  'react-i18next',
  'lucide-react',
  '@auto-cc/shared',
  './ui/controls',
];

/** 判据 5：被放开的这条进口本体（它一旦长出桥接口或网络口，判据 1 的放开就变成了开能力口）。 */
const UI_PRIMITIVES = 'packages/renderer/src/ui/controls.tsx';

/** 桥接口上唯一允许的服务命名空间与方法（`window.autoCC.funnel.query`）。 */
const ALLOWED_BRIDGE_PATH = 'funnel.query';

/** 一条禁令：模式 + 它对应的判据编号与后果（禁止清单不是随手列的黑名单）。 */
interface Ban {
  readonly pattern: RegExp;
  readonly reason: string;
}

/** 判据 3：任何网络 / 动态装载 / 进程出口，出现即失败。 */
const OUTBOUND_BANS: readonly Ban[] = [
  { pattern: /\bfetch\s*\(/, reason: '渲染层自己出网（§8.1 的隔离与 §7.2 的零出网都不复存在）' },
  { pattern: /\bXMLHttpRequest\b/, reason: '绕开桥接口的第二条网络通道（§8.2 禁止万能透传的同一件事）' },
  { pattern: /\bWebSocket\b|\bEventSource\b/, reason: '长连接会把"只读快照"变成第二套实时通道（§2.7）' },
  { pattern: /\bsendBeacon\b/, reason: '静默上报，等于给外发开一个不留回执的口' },
  { pattern: /\bimport\s*\(/, reason: '动态 import 绕过进口清单（判据 1 就形同虚设）' },
  { pattern: /\brequire\s*\(/, reason: '渲染层碰 Node 能力（§5.8 的底线）' },
];

/** 判据 4：按钮的 onClick 只允许这一个形状（重读看板，不触发任何动作）。捕获组已经把花括号外去了。 */
const ALLOWED_ON_CLICK = /^\(\s*\)\s*=>\s*void\s+read\(\s*\)$/;

/**
 * 判断一行是不是注释行（沿用调度器那条的口径：行首 `//`、`*`、`/*`、`{/*`、`*\/}`）。
 * @param line 去掉行首空白后的源码行
 * @returns 该行是否只承载注释文本
 */
function isCommentLine(line: string): boolean {
  return (
    line.startsWith('//') ||
    line.startsWith('/*') ||
    line.startsWith('*') ||
    line.startsWith('{/*') ||
    line.startsWith('*/}')
  );
}

/**
 * 取出源码里的 `import ... from '<说明符>'` 与 `import '<说明符>'` 的说明符列表。
 *
 * 按整段文本匹配而不是按行：本项目的长 import 是换行写的
 * （`import {\n  dayKey,\n  ...\n} from '@auto-cc/shared';`），逐行匹配会把这一整个进口漏掉，
 * 于是"进口清单"就漏了最容易塞进能力包的那一行（判据 1 形同虚设）。
 * @param source 已把注释行清空的源码
 * @returns 每个 import 语句的模块说明符（动态 `import(` 不在内，它由判据 3 拦）
 */
function importSpecifiersOf(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/\bimport\s+[\s\S]*?\bfrom\s+['"]([^'"]+)['"]/g)) {
    if (match[1]) found.push(match[1]);
  }
  for (const match of source.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)) {
    if (match[1]) found.push(match[1]);
  }
  return [...new Set(found)];
}

const problems: string[] = [];
let bridgeCallSites = 0;
let buttonCount = 0;
let importStatementCount = 0;

for (const relPath of TARGETS) {
  const filePath = path.join(repoRoot, relPath);
  const text = readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  // 注释行不参与任何计数与禁令扫描；判据说明写在文件头。后面一律读 `code`，不读 `line`。
  const codeLines = lines.map((line, index) => ({ code: isCommentLine(line.trimStart()) ? '' : line, index }));

  // —— 判据 1：进口清单 ——
  const specifiers = importSpecifiersOf(codeLines.map((entry) => entry.code).join('\n'));
  importStatementCount += specifiers.length;
  for (const specifier of specifiers) {
    if (!ALLOWED_MODULES.includes(specifier)) {
      problems.push(`${relPath} 引了 ${specifier}：看板的进口只允许 ${ALLOWED_MODULES.join(' / ')}（判据 1）`);
    }
  }

  for (const { code, index } of codeLines) {
    if (code === '') continue;
    const where = `${relPath}:${String(index + 1)}`;

    // —— 判据 2：桥接口只许那一条路径 ——
    for (const match of code.matchAll(/\bbridge\s*\??\.\s*([A-Za-z_$][\w$]*)\s*\??\.\s*([A-Za-z_$][\w$]*)/g)) {
      bridgeCallSites += 1;
      const callPath = `${match[1]}.${match[2]}`;
      if (callPath !== ALLOWED_BRIDGE_PATH) {
        problems.push(`${where} 调了桥接口的 ${callPath}：看板只允许 ${ALLOWED_BRIDGE_PATH}（判据 2）`);
      }
    }
    // 直接写 `window.autoCC.xxx` 而不是经 `bridge` 变量，是同一条口的绕法。
    for (const match of code.matchAll(/window\.autoCC\s*\??\.\s*([A-Za-z_$][\w$]*)/g)) {
      problems.push(`${where} 直接取 window.autoCC.${match[1]}：请经本组件的 bridge 变量走白名单那一只（判据 2）`);
    }

    // —— 判据 3：网络与进程出口 ——
    for (const ban of OUTBOUND_BANS) {
      if (ban.pattern.test(code)) problems.push(`${where} 命中 ${ban.pattern}：${ban.reason}`);
    }

    // —— 判据 4：按钮计数与它的 onClick（换进原件之后 `<button` 这个字面量会消失，两种写法都要认） ——
    buttonCount += (code.match(/<(?:button|DeskButton)\b/g) ?? []).length;
    for (const match of code.matchAll(/onClick=\{([^}]*)\}/g)) {
      const handler = match[1]?.trim() ?? '';
      if (!ALLOWED_ON_CLICK.test(handler)) {
        problems.push(`${where} 的 onClick 是 ${handler}：看板的点击只允许重读（void read()）（判据 4）`);
      }
    }
  }

  // JSX 的属性是跨行写的（`<button` 与 `data-action` 通常不在同一行），所以整段文本里核一次：
  // 全仓已经钉住"只有一只按钮"（下面 `buttonCount !== 1`），于是这句原话挂的就是那只按钮。
  // 换进 `DeskButton` 之后凭据写作 `action="refresh"`（原件自己把它渲染成 `data-action`），两种都认。
  const hasActionButton = /<(?:button|DeskButton)\b/.test(text);
  const hasRefreshCredential = /data-action="refresh"/.test(text) || /action="refresh"/.test(text);
  if (hasActionButton && !hasRefreshCredential) {
    problems.push(`${relPath} 里有按钮但找不到 refresh 那只的 data-action：看板只允许那只重读按钮（判据 4）`);
  }
}

// —— 判据 5：被放开的这条进口本体必须只是"画界面"的 ——
{
  const filePath = path.join(repoRoot, UI_PRIMITIVES);
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
  const code = lines.map((line) => (isCommentLine(line.trimStart()) ? '' : line)).join('\n');
  for (const ban of OUTBOUND_BANS) {
    if (ban.pattern.test(code)) problems.push(`${UI_PRIMITIVES} 命中 ${ban.pattern}：${ban.reason}（判据 5）`);
  }
  if (/\bwindow\.autoCC\b/.test(code) || /\bbridge\s*\??\./.test(code)) {
    problems.push(`${UI_PRIMITIVES} 里出现了桥接口：判据 1 放开的是一条只画界面的通道（判据 5）`);
  }
  for (const specifier of importSpecifiersOf(code)) {
    if (!['react', 'i18next', 'lucide-react', '@auto-cc/shared'].includes(specifier)) {
      problems.push(`${UI_PRIMITIVES} 引了 ${specifier}：原件只许引 react / 图标 / 类型包（判据 5）`);
    }
  }
}

if (buttonCount !== 1) {
  problems.push(`看板里的 <button> 数量是 ${String(buttonCount)}，判据要求"只有一只重读按钮"= 恰好 1 处（判据 4）`);
}
if (bridgeCallSites !== 1) {
  problems.push(
    `看板里的桥接调用点是 ${String(bridgeCallSites)} 处，判据要求只有那一句 ${ALLOWED_BRIDGE_PATH}（判据 2）`,
  );
}
if (importStatementCount === 0) {
  problems.push(`看板组件里一条 import 都没解析出来：多半是形状改了而本检查没跟上，先修这里再谈判据`);
}

if (problems.length) {
  console.error('✖ 看板只读性静态检查未通过（spec 5.8-02 组件半边）：');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(
  `✔ 看板保持只读（${TARGETS.join('、')}：${String(importStatementCount)} 条 import 全在清单里（含放开给原件的那一条）、` +
    `桥接口只有 ${ALLOWED_BRIDGE_PATH} 一处、0 处网络/动态装载出口、恰好 1 只按钮且它的 onClick 只是重读；` +
    `原件本体 ${UI_PRIMITIVES} 无桥接口与网络口）`,
);
