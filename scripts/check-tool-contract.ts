/**
 * agent 工具契约机检（spec 5.1-02 的「缺失即失败」，加上 5.1-06 / 5.1-07 的「列举清单对齐」）。
 *
 * 5.1-a 已经让 `titleKey` 变成声明里的必填字段，但**类型只保证"写了这个字段"**：
 * 写成 `'点击控件'`（把文案本身当 key）、写成 `agent.tool.labels.pageClicl`（拼错一截）、
 * 或者补了 `zh-CN` 忘了 `en`，全都是编译期合法、运行期在界面上显示成裸 key 或中文的缺陷。
 * 所以这里按源码里的**声明现场**逐条查六件事：
 * 1. 每处 `agentTool({…})` 都读得出字符串字面量 `id` 与 `titleKey`（动态拼出来的对不上机检，也就会话里变一只幽灵工具）；
 * 2. `titleKey` 是键不是文案：形状 `agent.tool.labels.<camelCase>` 且全 ASCII；
 * 3. 该键在**每一份**语言包（`zh-CN` / `en`）的 `shell` 命名空间下都存在、非空，且非中文 locale 里不许还是中文；
 * 4. `id` 全局唯一、`id` ↔ `titleKey` 一一对应，语言包的 labels 一节里不许有没人引用的孤儿键（§2.4 的死文案）；
 * 5. spec 点名的 P2 八件与 P4 四件能力都在声明现场出现（缺一条就是那条能力没接进对话入口）；
 * 6. 登记方服务在装配清单里排在注册表 `agent` **之后**——清单顺序即挂载顺序，排在前面就等于 init 时
 *    软问 `agent.tools` 问不到，那只工具静默地不进清单（5.1-c 的活体日志实测到的就是这一条，见下）。
 * 7. 每处声明的 `input` 顶层是 `z.strictObject`（spec 5.1-04 的"非法入参被拒绝"半边）：`z.object` 会把多余键
 *    原样递给实现，模型或界面多拼一个字段就不再是"这一只工具的入参"。
 * 8. 能力清单里的 12 件没有一件声明 `disabled`（spec 5.1-10 与 5.1-06 / 07 的连带）：禁用位是给"登记了但
 *    暂不开放"用的，把它用在清单内的工具上，等于让那两条判据当场失去对象。
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
  /** 声明所在的服务类名（取声明之前最后一个 `class X extends Service`）；在类体外登记时为 null */
  ownerClass: string | null;
  /** 入参 schema 的顶层形状：`strict` / `loose`（多余键放行）/ `unreadable`（读不出，按失败处理） */
  inputShape: 'strict' | 'loose' | 'unreadable';
  /** `input:` 现场读到的原文片段，失败信息里要指回它 */
  inputReadAs: string;
  /** 是否声明了 `disabled: true`（spec 5.1-10） */
  isDisabled: boolean;
}

/**
 * 取 `at` 之前最后一个 `class X extends Service` 的类名，即「这只工具是在哪个服务的类体里登记的」。
 * @param source 文件内容
 * @param at 声明现场（对象字面量左花括号）的下标
 * @returns 类名；声明在类体外时返回 null
 */
function ownerClassOf(source: string, at: number): string | null {
  let last: string | null = null;
  for (const hit of source.slice(0, at).matchAll(/\bclass\s+([A-Z]\w*)\s+extends\s+Service\b/g)) {
    last = hit[1] ?? null;
  }
  return last;
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
 * 摘出一段源码里所有 `agentTool({…})` 声明的 `id`、`titleKey`、入参形状与禁用位。
 * @param file 文件绝对路径（只用于回填现场）
 * @param source 文件内容
 * @param schemaShapes 具名 schema 的顶层形状表：`input: scriptRequestSchema` 这类声明要靠它对上
 * @returns 每个声明一个现场；花括号配不上时记一条失败并返回已读到的部分
 */
function declarationsOf(
  file: string,
  source: string,
  schemaShapes: Map<string, 'strict' | 'loose'>,
): DeclarationSite[] {
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
    // 入参形状只查顶层：嵌套 schema 是领域对象自己的口径，这条判据管的是"进门这一层挡不挡多余键"（5.1-04）。
    // 注意 `topLevel` 里 depth>1 的字符已被抹成空格，`z.strictObject(` 的左括号读不到，所以判到名字为止。
    const strictInline = /(?:^|[{,\s])input\s*:\s*z\.strictObject/.test(topLevel);
    const looseInline = /(?:^|[{,\s])input\s*:\s*z\.object/.test(topLevel);
    const namedInput = /(?:^|[{,\s])input\s*:\s*([A-Za-z_$][\w$]*)/.exec(topLevel)?.[1] ?? null;
    const inputAt = /(?:^|[{,\s])input\s*:/.exec(topLevel);
    found.push({
      file,
      line: source.slice(0, braceAt).split('\n').length,
      id: readLiteral('id'),
      titleKey: readLiteral('titleKey'),
      ownerClass: ownerClassOf(source, braceAt),
      inputShape: strictInline
        ? 'strict'
        : looseInline
          ? 'loose'
          : ((namedInput === null ? undefined : schemaShapes.get(namedInput)) ?? 'unreadable'),
      inputReadAs: inputAt
        ? topLevel
            .slice(inputAt.index + inputAt[0].length, inputAt.index + inputAt[0].length + 40)
            .replace(/\s+/g, ' ')
            .trim()
        : '（读不出 input 这一项）',
      isDisabled: /(?:^|[{,\s])disabled\s*:\s*true\b/.test(topLevel),
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
/** 非测试源码先读一遍：`input: scriptRequestSchema` 的形状可能定义在同包的另一处。 */
const sources = new Map<string, string>();
for (const file of tsFiles) {
  // 测试替身里的声明是给注册表单测用的假工具，不进界面，也就没有翻译要对。
  if (isTestOnlyModule(relative(file))) continue;
  sources.set(file, await readFile(file, 'utf8'));
}

/** 具名 schema 常量 → 顶层形状，供声明现场把 `input: 某Schema` 对上 strict / loose（spec 5.1-04）。 */
const schemaShapes = new Map<string, 'strict' | 'loose'>();
for (const source of sources.values()) {
  for (const hit of source.matchAll(
    /(?:^|\n)\s*(?:export )?const\s+(\w+)\s*(?::[^=\n]*)?=\s*z\.(strictObject|object)\(/g,
  )) {
    schemaShapes.set(hit[1] as string, hit[2] === 'strictObject' ? 'strict' : 'loose');
  }
}

for (const [file, source] of sources) {
  sites.push(...declarationsOf(file, source, schemaShapes));
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

/**
 * 能力清单（spec 5.1-06 / 5.1-07 要的"列举清单对齐"那半边）。
 *
 * 为什么把清单钉在脚本里，而不是从各包 service 名现推：那两条判据说的是**界面与对话能调到的能力**
 * 有没有缺，而"某个包提供了什么服务"是装配面的事实、会随重构漂移——用它当判据就等于让判据跟着被测物
 * 一起改。清单按 spec 原文逐字抄（P2 八件来自 2.8-08 的括号，P4 四件是 5.1-07 的括号），
 * 只补一列 id 把它落到具体工具上；新增能力要先进 spec 再进这里，顺序反过来就是先写实现后补验收。
 */
const CAPABILITY_CHECKLIST: readonly {
  readonly group: string;
  readonly items: readonly (readonly [string, string])[];
}[] = [
  {
    group: 'P2 浏览器能力（spec 2.8-08 的八件）',
    items: [
      ['打开会话', 'sessions.open'],
      ['导航', 'browser.page.navigate'],
      ['定位', 'browser.locate.find'],
      ['读取', 'browser.page.snapshot'],
      ['点击', 'browser.act.click'],
      ['输入', 'browser.act.type'],
      ['打招呼', 'outbound.greet.perform'],
      ['投递', 'outbound.deliver.perform'],
    ],
  },
  {
    group: 'P4 内容能力（spec 5.1-07 的四件）',
    items: [
      ['建档', 'resume.parse.fromFile'],
      ['检索', 'kb.profile.search'],
      ['生成简历', 'resume.generate.run'],
      ['生成话术', 'outbound.script.generate'],
    ],
  },
];

for (const group of CAPABILITY_CHECKLIST) {
  for (const [capability, id] of group.items) {
    if (!idsSeen.has(id)) {
      failures.push(
        `${group.group} 的「${capability}」没有以工具形式登记（注册表里读不到 id「${id}」）：5.9 的双入口少了一条腿`,
      );
    }
  }
}

const checklistCount = CAPABILITY_CHECKLIST.reduce((total, group) => total + group.items.length, 0);

/**
 * 入参形状判据（spec 5.1-04 的"非法入参被拒绝"半边）。
 *
 * 校验发生在注册表里（`tool.input.safeParse` 在 `run` 之前），所以"进了实现没有"是可测的行为；
 * 但**拦得住多少**取决于声明本身：`z.object` 会把模型多拼的键原样递给实现，`min(1)` 缺失会把空串递进去。
 * 这一条把口径钉在源码现场——比运行期遍历清单更早（提交期就红），也比"记得写 strictObject"更硬。
 */
let strictChecked = 0;
for (const site of sites) {
  const where = `${relative(site.file)}:${String(site.line)}`;
  const toolName = site.id ?? '（读不出 id）';
  if (site.inputShape === 'strict') {
    strictChecked += 1;
    continue;
  }
  if (site.inputShape === 'loose') {
    failures.push(
      `${where} 的工具「${toolName}」入参是 z.object（现场：input: ${site.inputReadAs}）：多余键会被放行到实现里，5.1-04 要的"非法入参零副作用"就成了只看运气的承诺`,
    );
    continue;
  }
  failures.push(
    `${where} 的工具「${toolName}」读不出入参形状（既不是 z.strictObject，也解析不到具名 schema 常量；现场：input: ${site.inputReadAs}）：机检无法确认它挡得住非法入参`,
  );
}
if (sites.length > 0 && strictChecked === 0)
  failures.push('入参形状判据一条都没比对成功：声明里都不带 input，或 zod 的写法变了，这条机检已失效');

/**
 * 禁用位判据（spec 5.1-10 与 5.1-06 / 07 的连带）。
 *
 * `disabled` 是"登记了但暂不开放"的声明位，本身合法；不合法的是把它用在能力清单里的工具上——
 * 那 12 件的判据原文是"以工具形式可见"，一禁用它们就从清单里消失，而声明现场看着齐全、单测也照样绿。
 */
for (const site of sites) {
  if (!site.isDisabled || site.id === null) continue;
  if (CAPABILITY_CHECKLIST.some((group) => group.items.some(([, id]) => id === site.id))) {
    failures.push(
      `${relative(site.file)}:${String(site.line)} 把清单内的能力「${site.id}」声明成 disabled：它对 agent 既不可见也不可调用，5.1-06 / 07 的清单当场对不上`,
    );
  }
}

/**
 * 装配顺序判据（5.1-c 的活体实测逼出来的一条）。
 *
 * 登记工具的服务在自己的 `[Service.init]` 里**软问** `agent.tools`（软问是为了让 agent 包能被单独摘掉，
 * 见 cordis.yml 里 `agent` 那一行的注释），而 kernel 是按 `cordis.yml` 的清单顺序逐个 await 挂载的：
 * 登记方排在注册表之前，init 那一刻问不到东西，`registerAgentTools` 如实返回 0 并把「注册表未挂载」
 * 打进日志——界面上那只工具从此不存在，但没有任何一处报错。5.1-c 给 `outbound.script` 加工具时撞上的就是它：
 * 真 app 日志读数 `话术生成就绪 … agent 工具登记 0 个（注册表未挂载）`，活体清单 15 只、缺 `outbound.script.generate`，
 * 而同一天 `pnpm test` 全绿（包内用例都先把注册表替身挂在登记方前面，顺序问题在单测里根本不存在）。
 * 所以这条只能查装配文件本身：代码、语言包、单测三处都对不上它。
 *
 * 查法是「声明现场所在的服务类 → registry.ts 的插件 id → cordis.yml 里的位置」三段串起来，
 * 三段里任何一段读不出来都记失败（宁可报错也不要把「没查到」过成「查过了」）。
 */
const REGISTRY_PLUGIN_ID = 'agent';

/** `packages/main/src/registry.ts`：插件 id → 实现类名（清单只写 id，类在这里给）。 */
const registrySource = await readFile(path.join(repoRoot, 'packages/main/src/registry.ts'), 'utf8');
const classByPluginId = new Map<string, string>();
for (const hit of registrySource.matchAll(/^\s*'?([\w-]+)'?:\s*([A-Z]\w*),\s*$/gm)) {
  classByPluginId.set(hit[1] as string, hit[2] as string);
}

/** 根 `cordis.yml` 的 `plugins:` 清单，数组下标即挂载顺序。 */
const manifestSource = await readFile(path.join(repoRoot, 'cordis.yml'), 'utf8');
const manifestOrder = [...manifestSource.matchAll(/^\s{2}-\s+id:\s*([\w-]+)\s*$/gm)].map((hit) => hit[1] as string);
const positionOf = new Map(manifestOrder.map((id, index) => [id, index]));

if (manifestOrder.length === 0) failures.push('cordis.yml 的 plugins 清单读不出任何 `- id:`：装配顺序判据已失效');
const registryAt = positionOf.get(REGISTRY_PLUGIN_ID);
if (registryAt === undefined)
  failures.push(`cordis.yml 清单里没有 ${REGISTRY_PLUGIN_ID} 这一行：注册表不挂载，所有工具都登记不上`);

/** 真的比对成功的对数；0 表示一条都没查成（判据失效，而不是碰巧没问题）。 */
let orderChecked = 0;
if (registryAt !== undefined) {
  for (const site of sites) {
    const where = `${relative(site.file)}:${String(site.line)}`;
    if (!site.ownerClass) {
      failures.push(`${where} 的 agentTool 声明读不出所在服务类（登记在类体外？），装配顺序判据对不上它`);
      continue;
    }
    const pluginId = [...classByPluginId].find(([, className]) => className === site.ownerClass)?.[0];
    if (!pluginId) {
      failures.push(
        `${where} 的登记方 ${site.ownerClass} 不在 packages/main/src/registry.ts 的「插件 id → 类」表里：它挂不上，工具也就进不了清单`,
      );
      continue;
    }
    const at = positionOf.get(pluginId);
    if (at === undefined) {
      failures.push(
        `${where} 的登记方 ${site.ownerClass}（插件 id ${pluginId}）没出现在 cordis.yml 清单里：装配面上没有它`,
      );
      continue;
    }
    orderChecked += 1;
    if (at < registryAt) {
      failures.push(
        `${where} 的登记方 ${pluginId} 在 cordis.yml 里排在 ${REGISTRY_PLUGIN_ID} 之前（第 ${String(at + 1)} 项 vs 第 ${String(registryAt + 1)} 项）：挂载时注册表还不存在，这只工具会静默不进清单`,
      );
    }
  }
}
if (sites.length > 0 && orderChecked === 0)
  failures.push('装配顺序判据一条都没比对成功：registry.ts 或 cordis.yml 的形状变了，这条机检已失效');

if (failures.length) {
  console.error('✖ agent 工具契约检查未通过（spec 5.1-02：titleKey 是键，且两份语言包都得翻得出言）：');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(
  `✔ agent 工具契约检查通过（${String(sites.length)} 只工具 × ${String(locales.length)} 份语言包：titleKey 形状合规、逐条有非空翻译、与 id 一一对应，labels 一节无孤儿键；能力清单 ${String(checklistCount)} 件逐条对得上登记；${String(strictChecked)} 只工具入参顶层全是 z.strictObject 且清单内无 disabled 位；${String(orderChecked)} 个登记方都排在注册表 ${REGISTRY_PLUGIN_ID} 之后）`,
);
