/**
 * 机检：模型在「这一步能不能执行」这条口上**没有表态通道**（spec 5.2-07）。
 *
 * 判法不是「跑一个用例看它有没有听话」，而是把四条结构性事实钉住——只要结构在，措辞就没得可听：
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
const tierWriters = sourceFiles.filter((relative) => read(relative).includes('setAutonomy')).sort();
if (tierWriters.join(',') !== [...tierWriteAllowlist].sort().join(',')) {
  problems.push(
    `写档位的口子应当只有这三处（${tierWriteAllowlist.join(' / ')}），现在提到 setAutonomy 的文件是：${tierWriters.join(' / ') || '（一个都没有）'}`,
  );
}
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

if (problems.length) {
  console.error('✖ agent 模型表态通道检查未通过：');
  for (const problem of problems) console.error(`  · ${problem}`);
  process.exit(1);
}
console.log(
  '✔ agent 模型表态通道检查通过（LoopModel 两条口 / StepPermissionRequest 三位 / decide 实参不含模型产出 / policy 不 import model / 升档只有人这一条口）',
);
