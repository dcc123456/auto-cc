/**
 * agent 工具契约机检（spec 5.1-02 的「缺失即失败」那半条）。
 *
 * 5.1-a 已经让 `titleKey` 变成声明里的必填字段，但**类型只保证"写了这个字段"**：
 * 写成 `'点击控件'`（把文案本身当 key）、写成 `agent.tool.labels.pageClicl`（拼错一截）、
 * 或者补了 `zh-CN` 忘了 `en`，全都是编译期合法、运行期在界面上显示成裸 key 或中文的缺陷。
 * 所以这里按源码里的**声明现场**逐条查四件事：
 * 1. 每处 `agentTool({…})` 都读得出字符串字面量 `id` 与 `titleKey`（动态拼出来的对不上机检，也就会话里变一只幽灵工具）；
 * 2. `titleKey` 是键不是文案：形状 `agent.tool.labels.<camelCase>` 且全 ASCII；
 * 3. 该键在**每一份**语言包（`zh-CN` / `en`）的 `shell` 命名空间下都存在、非空，且非中文 locale 里不许还是中文；
 * 4. `id` 全局唯一、`id` ↔ `titleKey` 一一对应，语言包的 labels 一节里不许有没人引用的孤儿键（§2.4 的死文案）。
 *
 * 为什么直查语言包而不复用 `check-renderer-conventions.ts` 的键对齐：那条判据是「各 locale 的键集相等」，
 * 两份**同时缺**一个键时它照样绿，而注册表缺的正是那一种（注册表在能力包，语言包在渲染层，没人逼着两边同步）。
 * 这里要的是「声明里出现的每个键都能翻出言」，方向相反，所以是同一份语言包的第二次读取而不是第二套判据。
 *
 * 反向断言：扫到的声明数为 0 就失败。否则 helper 改个名（或声明挪进 json 配置）会让这条检查静默变成永真
 * ——与 `check-prompts.ts` 对注册表份数的处理同一条理由。
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  blankOutStringsAndComments,
  filesIn,
  isTestOnlyModule,
  packageDirs,
  relative,
  repoRoot,
} from './internal/scan.js';

const failures: string[] = [];

/** 渲染层的默认命名空间：注册表给的 key 不带它，`t()` 取值时才拼上（i18next `defaultNS`）。 */
const I18N_NAMESPACE = 'shell';

/** `titleKey` 的键名前缀，语言包里 labels 一节也按它定位。 */
const LABEL_PREFIX = 'agent.tool.labels.';

/** 合规形状：前缀 + 一段 camelCase 标识符，全 ASCII（含汉字就是把文案写进了 key）。 */
const TITLE_KEY_SHAPE = /^agent\.tool\.labels\.[A-Za-z][A-Za-z\d]*$/;

/** 判「这条 locale 该不该出中文」用：只有 `zh*` 允许汉字。 */
const CJK = /[\u4e00-\u9fff]/;

/** 只扫 TS 源码：工具声明是代码，不会写在 json / yml 里。 */
const isTs = (name: string): boolean => /\.(?:ts|tsx)$/.test(name);

/** 括号配对的三类开合字符（`(` 与 `[` 也要算，否则 `run: (x) => {…}` 会把深度算漏）。 */
const OPENERS = '{([';
const CLOSERS = '})]';

/** 一处 `agentTool` 声明在源码里读得出的事实。 */
interface DeclarationSite {
  /** 声明所在文件的绝对路径 */
  file: string;
  /** 对象字面量起始行号（1 起，报错时指得清位置） */
  line: number;
  /** 工具的注册 id；读不出字面量时为 null */
  id: string | null;
  /** 界面标题的 i18n key；读不出字面量时为 null */
  titleKey: string | null;
}

/**
 * 找到与 `openAt` 处左括号配对的右括号。
 * @param blanked 去掉字符串与注释内容的源码（字符串里的括号不该参与配对）
 * @param openAt 左括号在文本中的下标
 * @returns 配对右括号下标；配不上（文本被截断等）时返回 -1
 */
function closingAt(blanked: string, openAt: number): number {
  let depth = 0;
  for (let index = openAt; index < blanked.length; index += 1) {
    const char = blanked[index];
    if (char && OPENERS.includes(char)) depth += 1;
    else if (char && CLOSERS.includes(char)) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * 把对象字面量压成「只剩顶层」的文本：深度大于 1 的字符换成空格，长度与下标不变。
 *
 * 需要它是因为 `input: z.strictObject({ id: z.string() })` 里也有一个 `id:`——
 * 不抹掉嵌套内容，读 `id` 就会读到 schema 的字段名上去。
 * @param source 原始源码（值要从这里取，字符串内容得留着）
 * @param blanked 去掉字符串与注释内容的源码（只用来数括号）
 * @param from 对象字面量左花括号下标
 * @param to 配对的右花括号下标（含）
 * @returns 与原文等长的片段，只有顶层的 `key: 'value'` 还可读
 */
function keepTopLevelOnly(source: string, blanked: string, from: number, to: number): string {
  const chars: string[] = [];
  let depth = 0;
  for (let index = from; index <= to; index += 1) {
    const char = blanked[index] ?? '';
    if (OPENERS.includes(char)) depth += 1;
    const isTopLevel = depth === 1;
    if (CLOSERS.includes(char)) depth -= 1;
    chars.push(isTopLevel ? (source[index] ?? ' ') : ' ');
  }
  return chars.join('');
}

/**
 * 摘出一段源码里所有 `agentTool({…})` 声明的 `id` 与 `titleKey`。
 * @param file 文件绝对路径（只用于回填现场）
 * @param source 文件内容
 * @returns 每个声明一个现场；花括号配不上时记一条失败并返回已读到的部分
 */
function declarationsOf(file: string, source: string): DeclarationSite[] {
  const blanked = blankOutStringsAndComments(source);
  const found: DeclarationSite[] = [];
  const opener = /agentTool\s*\(\s*\{/g;
  for (let hit = opener.exec(blanked); hit; hit = opener.exec(blanked)) {
    const braceAt = hit.index + hit[0].length - 1;
    const closeAt = closingAt(blanked, braceAt);
    if (closeAt < 0) {
      failures.push(`${relative(file)} 里的 agentTool 声明花括号配不上，无法读出它的 id / titleKey`);
      break;
    }
    const topLevel = keepTopLevelOnly(source, blanked, braceAt, closeAt);
    const readLiteral = (key: string): string | null => {
      const field = new RegExp(`(?:^|[{,\\s])${key}\\s*:\\s*(['"])([^'"]*)\\1`).exec(topLevel);
      return field?.[2] ?? null;
    };
    found.push({
      file,
      line: source.slice(0, braceAt).split('\n').length,
      id: readLiteral('id'),
      titleKey: readLiteral('titleKey'),
    });
  }
  return found;
}

/**
 * 沿路径下钻语言包对象。
 * @param root 解析后的语言包
 * @param segments 逐级键名（含命名空间）
 * @returns 命中的节点；任一段不是对象或键不存在时返回 undefined
 */
function nodeAt(root: unknown, segments: readonly string[]): unknown {
  let node: unknown = root;
  for (const segment of segments) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** 一份语言包：文件名下标 + 解析结果 + 它覆盖的 labels 键。 */
interface LocalePack {
  name: string;
  labels: Map<string, string>;
}

/**
 * 读 `packages/renderer/src/locales/*.json`。
 * @returns 每个语言包一份；键为 labels 一节下的末段名，值为文案
 */
async function localePacks(): Promise<LocalePack[]> {
  const localesDir = path.join(repoRoot, 'packages/renderer/src/locales');
  const names = (await readdir(localesDir)).filter((name) => name.endsWith('.json')).sort();
  const packs: LocalePack[] = [];
  for (const name of names) {
    const root = JSON.parse(await readFile(path.join(localesDir, name), 'utf8')) as unknown;
    const section = nodeAt(root, [I18N_NAMESPACE, 'agent', 'tool', 'labels']);
    const labels = new Map<string, string>();
    if (section && typeof section === 'object') {
      for (const [key, value] of Object.entries(section as Record<string, unknown>)) {
        if (typeof value === 'string') labels.set(key, value);
      }
    }
    packs.push({ name, labels });
  }
  return packs;
}

const tsFiles = (
  await Promise.all((await packageDirs()).map((dir) => filesIn(dir, isTs).catch(() => [] as string[])))
).flat();

const sites: DeclarationSite[] = [];
for (const file of tsFiles) {
  // 测试替身里的声明是给注册表单测用的假工具，不进界面，也就没有翻译要对。
  if (isTestOnlyModule(relative(file))) continue;
  sites.push(...declarationsOf(file, await readFile(file, 'utf8')));
}

// 反向断言：一只都没扫到 == 判据本身失效，不能算通过。
if (sites.length === 0) {
  console.error('✖ agent 工具契约检查未通过：一个 agentTool 声明都没扫到，判据已失效（helper 改名或声明挪出源码了？）');
  process.exit(1);
}

const locales = await localePacks();
if (locales.length === 0) failures.push('渲染层语言包目录下一个 .json 都没有，titleKey 无从校验');
for (const required of ['zh-CN.json', 'en.json']) {
  if (!locales.some((pack) => pack.name === required))
    failures.push(`语言包 ${required} 缺席（spec 5.1-02 要求 zh-CN 与 en 两份齐）`);
}

const idsSeen = new Map<string, DeclarationSite>();
const keyOwners = new Map<string, string[]>();
const referenced = new Set<string>();

for (const site of sites) {
  const where = `${relative(site.file)}:${String(site.line)}`;
  if (!site.id) {
    failures.push(`${where} 的 agentTool 声明读不出字符串字面量 id：注册表与「agent.*」服务名都对不上`);
  } else {
    const first = idsSeen.get(site.id);
    if (first)
      failures.push(`${where} 重复登记 id「${site.id}」，首处在 ${relative(first.file)}:${String(first.line)}`);
    else idsSeen.set(site.id, site);
  }

  if (!site.titleKey) {
    failures.push(
      `${where} 工具「${site.id ?? '（读不出 id）'}」缺 titleKey，或它不是字符串字面量（模板串拼出来的 key 机检与语言包都对不上）`,
    );
    continue;
  }
  if (!TITLE_KEY_SHAPE.test(site.titleKey)) {
    failures.push(
      `${where} titleKey「${site.titleKey}」不合规：必须是 ${LABEL_PREFIX}<camelCase> 形态的键，不是页面文案本身（spec 5.1-02）`,
    );
    continue;
  }
  const labelName = site.titleKey.slice(LABEL_PREFIX.length);
  referenced.add(labelName);
  keyOwners.set(labelName, [...(keyOwners.get(labelName) ?? []), site.id ?? where]);
  for (const pack of locales) {
    const text = pack.labels.get(labelName);
    if (text === undefined) {
      failures.push(`${where} 的 titleKey「${site.titleKey}」在 ${pack.name} 里没有翻译，界面上会显示成裸 key`);
      continue;
    }
    if (!text.trim()) failures.push(`${where} 的 titleKey「${site.titleKey}」在 ${pack.name} 里是空串`);
    // 非中文 locale 里仍是汉字 = 拿中文占位交差，等于没翻。
    if (!pack.name.startsWith('zh') && CJK.test(text)) {
      failures.push(`${pack.name} 里「${labelName}」的文案还是中文（${text}），spec 5.1-02 要的是两份都有对应翻译`);
    }
  }
}

for (const [labelName, owners] of keyOwners) {
  if (owners.length > 1) {
    failures.push(
      `titleKey「${LABEL_PREFIX}${labelName}」被 ${String(owners.length)} 只工具共用（${owners.join(' / ')}）：两张卡会是同一个标题`,
    );
  }
}

// 语言包侧的孤儿键：删了工具没删文案，读代码的人会以为还有这只手在用（§2.4）。
for (const pack of locales) {
  for (const labelName of pack.labels.keys()) {
    if (!referenced.has(labelName)) {
      failures.push(
        `${pack.name} 的 ${LABEL_PREFIX}${labelName} 没有任何 agentTool 声明引用：要么补上工具，要么删掉这条死文案`,
      );
    }
  }
}

if (failures.length) {
  console.error('✖ agent 工具契约检查未通过（spec 5.1-02：titleKey 是键，且两份语言包都得翻得出言）：');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(
  `✔ agent 工具契约检查通过（${String(sites.length)} 只工具 × ${String(locales.length)} 份语言包：titleKey 形状合规、逐条有非空翻译、与 id 一一对应，labels 一节无孤儿键）`,
);
