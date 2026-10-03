/**
 * 机检：模型在「这一步能不能执行」这条口上**没有表态通道**（spec 5.2-07）。
 *
 * 判法不是「跑一个用例看它有没有听话」，而是把这几条结构性事实钉住——只要结构在，措辞就没得可听：
 * ① `LoopModel` 恰好只有 `draftPlan` / `summarizeObservation` 两条方法：循环要问的只有这两件事，
 *   多出一条（例如 `askPermission`）就是给模型开了一条可以表态的口；
 * ② 判定请求 `StepPermissionRequest` 的字段恰好是 `tier` / `planConfirmed` / `toolId`，
 *   副作用与「模型说它安全」都不在其中；草案 `PlanStepDraft` 的字段也长不出 `approved` 那一位；
 * ③ `loop.ts` 里唯一那处 `this.policy.decide({...})` 的实参只读档位、确认位与工具 id，
 *   不出现 `intent` / `observation` / `summary` / `draft` / `steps` 这些模型产出的名字；
 * ④ `policy.ts` 不 import `model.ts`——判定口连模型的类型都不认识，就接不到它的话；
 * ⑤（5.3-a 加，spec 5.3-04）写档位的路径只有「人」那一条：`setAutonomy` 在全仓非测试源码里
 *   只许出现在定义处、IPC 白名单派发处、界面上那只切换这三份文件里，而 `UPDATE chat_session SET autonomy`
 *   全仓一处，`loop.ts` / `policy.ts` 连那一列的表名都不出现——循环只读档位。
 * ⑥（5.3-b 加，spec 5.3-06 / 07）写免确认白名单的路径同样只有「人」那一条：
 *   `setExempt` / `clearExempt` 只许出现在判定口、IPC 白名单派发处、界面上那两颗按钮这三份文件里，
 *   `agent_policy_exempt` 两张表只在判定口被碰，而 `loop.ts` 连名单的名字都不出现——
 *   循环每一步只把工具 id 交给判定口，「这只手免不免确认」由判定口现读库。
 *   这一条防的是 5.3-04 那个风险换一副面孔重演：模型若能自己加白，它就又能给自己放宽了。
 * ⑦（5.3-c 加，spec 5.3-09）应答暂停单的路径也只有「人」那一条：`respond` 的定义处、IPC 派发处、
 *   界面上发送表态的那一份文件之外不许有第四份提到它，`loop.ts` 里连 `respond(` 都不出现——循环只许开单等人，不许自己把单答了；
 *   同时 `pause.ts` 不许 import 循环或判定口（与 ④ 同形）：通道一旦认识 run，就有了第二处判定现场。
 *   这一条防的是第三种形态：模型把「批准自己」写成一只手，「等人批准」就变成「等人被跳过」。
 * ⑧（5.5-a 加，spec 5.5-01 / 02）恢复被人工接管按住的 run 也只有「人」那一条口：`agent.loop.resume`
 *   在全仓非测试源码里只许出现在定义处（`loop.ts`）与 IPC 白名单派发处（`bridge.ts`）两份文件里，
 *   而它**不登记为 agent 工具**（`agent.tools` 的清单里没有这一只，界面上那颗「继续」走桥接白名单）。
 *   这一条防的是第四种形态：接管若挡不住模型自己按「继续」，5.5-02 那句「接管期间一步都不发」就成了装饰。
 *
 * 探针（5.2-b 实测，三条各打一处再还原）：给 `StepPermissionRequest` 加一位 `authorized?: boolean`、
 * 把 ③ 的实参改成带 `step.intent`、给 `LoopModel` 多加一条 `requestPermission`，本脚本都在那一处立刻 exit 1。
 * 结论与还原凭据写在 spec 的 5.2-b 落地记录。
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), 'utf8');

/** 一条判据的失败原因清单；全空即通过。 */
const problems: string[] = [];

/**
 * 取一段声明体：从匹配 `startPattern` 的那一行起，到第一个匹配 `endPattern` 的行止。
 * @param source 文件原文
 * @param startPattern 起始行正则（例如 `export interface LoopModel \\{`）
 * @param label 出错时要报的块名
 * @param endPattern 收尾行正则；默认是顶格的 `}` 或 `};`（调用点那种带缩进的 `});` 要显式给）
 * @returns 块内文本（含首尾行）；找不到或不收尾时返回 null 并记一条问题
 */
function blockOf(source: string, startPattern: RegExp, label: string, endPattern = /^}|};/): string | null {
  const lines = source.split('\n');
  const startAt = lines.findIndex((line) => startPattern.test(line));
  if (startAt === -1) {
    problems.push(`找不到 ${label}——它被改名或删掉了？`);
    return null;
  }
  for (let index = startAt + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (endPattern.test(line)) return lines.slice(startAt, index + 1).join('\n');
  }
  problems.push(`${label} 没有收尾的一行`);
  return null;
}

/**
 * 断言一个块的成员名恰好等于期望清单（顺序无关）。
 * @param block 块文本
 * @param memberPattern 从每行提出成员名的正则（须捕获组 1）
 * @param expected 期望成员名集合
 * @param label 块名，报错时用
 */
function expectMembers(block: string, memberPattern: RegExp, expected: readonly string[], label: string): void {
  const found: string[] = [];
  for (const line of block.split('\n')) {
    const matched = line.match(memberPattern);
    if (matched?.[1]) found.push(matched[1]);
  }
  const sortedFound = [...found].sort().join(',');
  const sortedExpected = [...expected].sort().join(',');
  if (sortedFound !== sortedExpected) {
    problems.push(`${label} 的成员应为 ${sortedExpected}，现在是 ${sortedFound || '（空）'}`);
  }
}

const modelSource = read('packages/agent/src/loop/model.ts');
const policySource = read('packages/agent/src/loop/policy.ts');
const loopSource = read('packages/agent/src/loop/loop.ts');

// ① 模型端口只有两条口。
const modelInterface = blockOf(modelSource, /^export interface LoopModel \{$/, 'LoopModel 接口');
if (modelInterface)
  expectMembers(modelInterface, /^ {2}([A-Za-z]+)\(/, ['draftPlan', 'summarizeObservation'], 'LoopModel 的方法');

// ② 判定请求与草案的字段：一处是给判定者的输入，一处是模型的输出，两边都不许带授权位。
const permissionType = blockOf(policySource, /^export type StepPermissionRequest = \{$/, 'StepPermissionRequest');
if (permissionType) {
  expectMembers(
    permissionType,
    /^ {2}([A-Za-z]+)[?]?:/,
    ['tier', 'planConfirmed', 'toolId'],
    'StepPermissionRequest 的字段',
  );
  const permissionFields = permissionType
    .split('\n')
    .filter((line) => /^ {2}[A-Za-z]+[?]?:/.test(line))
    .join('\n');
  if (/authorized|approved|allow|effect|side/i.test(permissionFields)) {
    problems.push('StepPermissionRequest 的字段名里出现了授权/副作用类词——判定者只能现读注册表，不能收模型的话');
  }
}
const draftTypeMatch = modelSource.match(/^export type PlanStepDraft = \{([^}]*)\}/m);
if (!draftTypeMatch) problems.push('找不到 PlanStepDraft 的类型声明');
else {
  const draftFields = [...draftTypeMatch[1]!.matchAll(/([A-Za-z]+)\s*:/g)].map((entry) => entry[1]!);
  if (draftFields.sort().join(',') !== 'input,intent,toolId') {
    problems.push(`PlanStepDraft 的字段应为 input,intent,toolId，现在是 ${draftFields.join(',') || '（空）'}`);
  }
}

// ③ 循环里判定只有一处，且实参里没有模型产出的名字。
const decideCalls = [...loopSource.matchAll(/this\.policy\.decide\(/g)];
if (decideCalls.length !== 1)
  problems.push(`循环里 this.policy.decide( 应恰好一处，现在 ${String(decideCalls.length)} 处`);
const decideBlock = blockOf(
  loopSource,
  /^ {6}const decision = this\.policy\.decide\(\{$/,
  'decide 调用的实参块',
  /^ {6}\}\);/,
);
if (decideBlock) {
  expectMembers(decideBlock, /^ {8}([A-Za-z]+):/, ['tier', 'planConfirmed', 'toolId'], 'decide 实参的字段');
  const leaked = ['intent', 'observation', 'summary', 'draft', 'steps', 'model'].filter((word) =>
    decideBlock.includes(word),
  );
  if (leaked.length) problems.push(`decide 的实参里读得到模型产出的名字：${leaked.join(' / ')}`);
}

// ④ 判定口不认识模型的类型。
if (/from '\.\/model\.js'/.test(policySource)) {
  problems.push('policy.ts 不该 import model.ts：判定口一旦认识模型的类型，就有一条可以听它表态的通道');
}

// ⑤ 档位不是 agent 的一只手（spec 5.3-04）：写 `chat_session.autonomy` 的路径必须只有「人」那一条。
//    判法不数工具清单（清单会长），而数**名字**：全仓非测试源码里能出现 `setAutonomy` 的文件是穷举过的三份——
//    定义处（session.ts）、IPC 白名单派发处（bridge.ts）、界面上那只切换（ChatPanel.tsx）。
//    多出第四份 = 有人给 agent 或某个后台路径开了第二条升档口；少了任何一份 = 这条口被改名了，判据失效。
const tierWriteAllowlist = [
  'packages/agent/src/session.ts',
  'packages/shared/src/bridge.ts',
  'packages/renderer/src/ChatPanel.tsx',
];
/**
 * 递归收集各包 `src` 目录下的源码文件（跳过测试与产物目录）。
 * @param current 当前目录（相对仓库根）
 * @returns 相对路径清单，顺序稳定（按目录名字典序，跨机器可比）
 */
function collectSources(current: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(path.join(repoRoot, current), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const relative = `${current}/${entry.name}`;
    if (entry.isDirectory()) found.push(...collectSources(relative));
    else if (/\.(?:ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) found.push(relative);
  }
  return found.sort();
}

const sourceFiles = collectSources('packages');

/**
 * 断言「这几个名字只许出现在这几份文件里」（⑤⑥ 共用同一判据形状）。
 *
 * 判法数**名字**而不是数工具清单：清单会长，而「谁能写这一位」是穷举过的事实——
 * 多出一份文件就是有人开了第二条口（给 agent，或给某条不用人点头的后台路径），少一份则说明这条口被改名、判据失效。
 * @param needles 要搜的名字，任一命中即算提到
 * @param allowlist 允许提到这些名字的文件（相对仓库根）
 * @param label 报错时说的事名
 */
function expectSingleWriter(needles: readonly string[], allowlist: readonly string[], label: string): void {
  const hits = sourceFiles
    .filter((relative) => {
      const text = read(relative);
      return needles.some((needle) => text.includes(needle));
    })
    .sort();
  if (hits.join(',') !== [...allowlist].sort().join(',')) {
    problems.push(
      `${label} 的口子应当只在这几处（${allowlist.join(' / ')}），现在提到 ${needles.join(' / ')} 的文件是：${hits.join(' / ') || '（一个都没有）'}`,
    );
  }
}

expectSingleWriter(['setAutonomy'], tierWriteAllowlist, '写档位');
// 那一列的 UPDATE 语句全仓只允许出现在 session.ts 一处——多一处就是第二套写入口（AGENTS.md §2.5）。
const updateHits = sourceFiles.filter((relative) => /UPDATE chat_session SET autonomy/.test(read(relative)));
if (updateHits.join(',') !== 'packages/agent/src/session.ts') {
  problems.push(
    `UPDATE chat_session SET autonomy 应只在 session.ts 出现一处，现在出现在：${updateHits.join(' / ') || '（没有）'}`,
  );
}
// 循环侧连那一列的名字都不该出现：它只读档位（`chat.session.current()`），不碰表。
for (const relative of ['packages/agent/src/loop/loop.ts', 'packages/agent/src/loop/policy.ts']) {
  const text = read(relative);
  if (text.includes('setAutonomy') || text.includes('chat_session')) {
    problems.push(`${relative} 里出现了 setAutonomy 或 chat_session——循环只该读档位，写档位不是它的手`);
  }
}

// ⑥（5.3-b 加，spec 5.3-06 / 07）免确认白名单也不是 agent 的一只手：写它的口只有「人」那一条。
//    判据与 ⑤ 同形——「agent 自己给自己放宽」若换个名字重演（模型把下一步要用的那只手先加白），
//    5.3-04 就白立了。三份文件分别是：定义处（policy.ts）、IPC 白名单派发处（bridge.ts）、界面上那两颗按钮（AgentPolicyPanel.tsx）。
expectSingleWriter(
  ['setExempt', 'clearExempt'],
  ['packages/agent/src/loop/policy.ts', 'packages/shared/src/bridge.ts', 'packages/renderer/src/AgentPolicyPanel.tsx'],
  '写免确认名单',
);
// 那两张表只许判定口自己碰：多出第二处就是第二套写入口（AGENTS.md §2.5），而名单是判定依据，两处能写就没人知道当下哪一份作数。
const exemptTableWriters = sourceFiles.filter((relative) => read(relative).includes('agent_policy_exempt'));
if (exemptTableWriters.join(',') !== 'packages/agent/src/loop/policy.ts') {
  problems.push(
    `agent_policy_exempt 两张表应只在 policy.ts 出现，现在出现在：${exemptTableWriters.join(' / ') || '（没有）'}`,
  );
}
// 循环侧同样连表名都不该出现：它每一步只把 id 交给判定口，名单由判定口现读（5.2-07 的「模型没有表态通道」延续到 5.3-b）。
const loopText = read('packages/agent/src/loop/loop.ts');
if (['setExempt', 'clearExempt', 'exemptList', 'agent_policy_exempt'].some((needle) => loopText.includes(needle))) {
  problems.push('loop.ts 里读得到免确认名单的名字——循环不该知道名单的存在，它只负责把每一步交给判定口');
}

// ⑦（5.3-c 加，spec 5.3-09）应答暂停单的口只有「人」那一条：定义处（pause.ts）、IPC 白名单派发处（bridge.ts），
//    以及界面上那四颗按钮把表态发出去的那一处（useAgentPause.ts）——5.3-c 的界面半边接上时补进了这份名单，
//    名单里少了它就是那条判据此刻不成立。
//    模型若能自己应答自己这一步的确认单，5.2-07 与 5.3-04 就一起作废：它只要把「批准」写成一只手，
//    「等人批准」就变成了「等人被跳过」。
//    搜的是这三个**具体形状**而不是裸词 `respond`：那一个词会命中「response」这类常见英文，
//    判据就会因为一句注释而随机失败，而一条会误报的机检最后只会被关掉。
//    `'pause.respond'` 是渲染层取桥接方法时用的键名（命名空间把 `agent.` 前缀提掉了），
//    它不会命中 `'agent.pause.respond'`，所以三份文件各由一个形状抓到，谁也不会被漏掉。
expectSingleWriter(
  ['respond(requestIdRaw', "'agent.pause.respond'", "'pause.respond'"],
  ['packages/agent/src/loop/pause.ts', 'packages/shared/src/bridge.ts', 'packages/renderer/src/useAgentPause.ts'],
  '应答暂停单',
);
// 循环只能开单等人：它读到 `respond(` 就等于自己把单答了，那一张卡片从此只是给界面看的装饰。
if (loopText.includes('respond(')) {
  problems.push('loop.ts 里读得到 respond( ——循环只许开单等人表态，应答不是它的手');
}
// 暂停通道也不许反过来认识循环与判定：判法与 ④ 同形——**看 import 而不是看注释里的提法**
// （注释里提到 `agent.loop` 是在解释副作用，那是给人看的；真出事的是它开始调判定口或读 run，那要多一处判定现场）。
const pauseSource = read('packages/agent/src/loop/pause.ts');
if (/from '\.\/(?:loop|policy)\.js'/.test(pauseSource)) {
  problems.push('pause.ts 不该 import loop.ts / policy.ts：通道只认单号与值，认了 run 就有第二处判定现场（§2.5）');
}

// ⑧（5.5-a 加，spec 5.5-01 / 02）恢复被人工接管按住的 run 只有「人」那一条口：定义处（loop.ts 的 `resume`）
//    与 IPC 白名单派发处（bridge.ts）之外不许有第三份文件提到它——界面上那只「继续」5.5-b 接上时补进名单，
//    名单里少了它就是那条判据此刻不成立（与 ⑦ 同一份长法）。
//    模型若能自己按「继续」，接管就挡不住任何东西：它只要在下一步之前把 run 恢复，
//    「人在页面上操作」这件事在系统里就成了一个可以随时被模型关掉的状态，5.5-02 当场作废。
//    搜的是这两个**具体形状**而不是裸词 `resume`：工作流那一路也有一条续跑的口（`resume()`），
//    把它的名字算进来会让这条判据指着错误的文件，而一条会误报的机检最后只会被关掉。
expectSingleWriter(
  ['resume(runIdRaw', "'agent.loop.resume'"],
  ['packages/agent/src/loop/loop.ts', 'packages/shared/src/bridge.ts'],
  '恢复被接管按住的 run',
);
// 这只口刻意**不登记为 agent 工具**：注册表那边的清单里读到它，就等于把人的表态做成了模型的一只手
//（`agent.tools` 是唯一的手册，5.1-08 / 5.2-07 同一条红线）。
const toolsSource = read('packages/agent/src/tools.ts');
if (toolsSource.includes('agent.loop.resume') || toolsSource.includes("'loop.resume'")) {
  problems.push('agent.loop.resume 被登记成了 agent 的手：恢复自动化只许由人按，不许出现在工具注册表里');
}

if (problems.length) {
  console.error('✖ agent 模型表态通道检查未通过：');
  for (const problem of problems) console.error(`  · ${problem}`);
  process.exit(1);
}
console.log(
  '✔ agent 模型表态通道检查通过（LoopModel 两条口 / StepPermissionRequest 三位 / decide 实参不含模型产出 / ' +
    'policy 不 import model / 升档只有人这一条口 / 加白与撤白只有人这一条口 / 应答暂停单只有人这一条口 / ' +
    '恢复被接管按住的 run 只有人这一条口）',
);
