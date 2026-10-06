/**
 * LLM 入口唯一性机检（spec 2.5-12 / 4.3-07，AGENTS.md §2.7「禁止第二套 LLM 客户端」的落地）。
 *
 * §2.7 那句禁令隐含一个前提：**第一套得有唯一归属**。不机检的话它必然失守——
 * 2.5 为了话术顺手发一个 `fetch`、P4 生成简历再发一个、P5 的 agent 规划再发一个，
 * 届时谁都不是那「一套」。所以这里只守两件事：
 * 1. 模型端点痕迹（`chat/completions`、`embeddings`、已知模型域名、`sk-…` 形态的密钥、模型 SDK 依赖）
 *    只允许出现在 `packages/llm` 里；
 * 2. `llm.*` 的 provider 名**每个只允许一个真实声明者**（测试替身不计入，见扫描循环里的豁免注释），
 *    且只允许 `chat` 与 `embed` 两个——
 *    4.3-d 的向量出口是同一个客户端的第二个方法（§2.2 抽的是传输骨架），
 *    但「第三个 llm.* 服务」就等于第二套客户端换了个名字，所以这里显式卡住白名单。
 *
 * 判定按**字符串字面量**而不是标识符：调用方伪造端点的方式是写一个新 URL，不是改函数名。
 */
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { filesIn, isTestOnlyModule, packageDirs, relative } from './internal/scan.js';

/** 唯一的模型出口包：只有这里的源码允许出现下列痕迹。 */
const LLM_PACKAGE = 'llm';
/** 模型出口（真正发请求的那两只）。 */
const ALLOWED_PROVIDERS = ['chat', 'embed'];
/**
 * `llm.settings` 是 7.1 加的配置模块，不是第三个出口：它一个字节都不发，连通性测试走 `llm.chat`。
 * 所以白名单给它单开一格，并额外守一条下面那个「不许碰传输骨架」的断言——
 * 哪天它 import 了 `http.js` 或自己 `fetch`，禁令就破功了，这里立刻红。
 */
const SETTINGS_PROVIDER = 'settings';

/**
 * 只服务于测试的文件（`.test.ts` / `.spec.ts` / `test-doubles.ts`）不算"真实实现"。
 * 口径来自 `scripts/internal/scan.ts`，与 `check-compliance-redlines.ts` 的同一条判断共用一份。
 */
const isScannable = (name: string): boolean => /\.(ts|tsx|mts|cts|js|json|yml)$/.test(name);

/** 一条「这是在直接够模型」的痕迹特征。 */
const MODEL_TRACES: readonly (readonly [RegExp, string])[] = [
  [/chat\/completions/, 'chat completion 端点路径'],
  [/\/v1\/completions\b/, 'completions 端点路径'],
  // 向量端点同样只许在 `packages/llm` 里出现（spec 4.3-07：检索侧只能经 `llm.embed` 要向量）。
  [/\/embeddings\b/, 'embeddings 端点路径'],
  [/\b(api\.)?(openai|deepseek|anthropic|moonshot|zhipuai|bigmodel|siliconflow)\.(com|ai|cn)\b/, '已知模型服务域名'],
  [/\bdashscope\.aliyuncs\.com\b/, '已知模型服务域名（DashScope）'],
  // 长度下限 20：真实密钥是这个量级，而 `sk-live-123456` 这类明显的测试假值不该被判成「在够模型」。
  [/\bsk-[A-Za-z0-9_-]{20,}/, '疑似 API key 字面量'],
  [/\bfrom\s+['"](?:openai|@anthropic-ai\/sdk|ollama)['"]/, '模型 SDK 依赖'],
];

const failures: string[] = [];

// `llm` 包自己也要扫：它只能有一个 provider 声明（第二条断言），但豁免端点痕迹（第一条断言）。
const allFiles = (
  await Promise.all((await packageDirs()).map((dir) => filesIn(dir, isScannable).catch(() => [] as string[])))
).flat();

/** 每个 `llm.<name>` provider 的声明者位置，用于「每个名字只允许一个声明者」的断言。 */
const providerDeclarations = new Map<string, string[]>();
/** 声明 `llm.settings` 的那个文件的**源码路径**（绝对），供下面「不许自己够传输层」那条断言读文件。 */
const settingsSources: string[] = [];

for (const file of allFiles) {
  const source = await readFile(file, 'utf8');
  const isLlmPackage = relative(file).startsWith(`packages/${LLM_PACKAGE}/`);
  source.split('\n').forEach((line, index) => {
    // 注释行不算痕迹：本文件与 spec 文档都要引用这些字样。
    const code = line.replace(/^\s*(?:\/\/|\*|\/\*).*$/, '');
    const declared = /provide\s*=\s*'llm\.([a-z]+)'/.exec(code)?.[1];
    // 测试替身不计入「声明者」：它同样 `provide = 'llm.embed'`（服务是按名字查的，替身必须占同一个名字），
    // 但它一个端点都不碰、向量来自内存 fixture。这条断言守的是「一个名字只有一个**真实实现**」，
    // 把替身算进来就等于禁止给 `llm.embed` 写用例；而端痕迹那一断言（下面）不豁免测试文件。
    if (declared !== undefined && !isTestOnlyModule(relative(file))) {
      providerDeclarations.set(declared, [
        ...(providerDeclarations.get(declared) ?? []),
        `${relative(file)}:${String(index + 1)}`,
      ]);
      if (declared === SETTINGS_PROVIDER) settingsSources.push(file);
    }
    if (isLlmPackage) return;
    for (const [pattern, label] of MODEL_TRACES) {
      if (pattern.test(code)) {
        failures.push(
          `${relative(file)}:${String(index + 1)} 出现${label}：模型调用只允许在 packages/${LLM_PACKAGE} 里发生，` +
            '请改为调用 `llm.chat` / `llm.embed`（spec 2.5-12 / 4.3-07）',
        );
      }
    }
  });
}

for (const [name, declarations] of providerDeclarations) {
  if (!ALLOWED_PROVIDERS.includes(name) && name !== SETTINGS_PROVIDER) {
    failures.push(
      `出现了白名单外的 llm.${name} 服务（${declarations.join('、')}）：` +
        `模型出口只允许 ${ALLOWED_PROVIDERS.map((allowed) => `llm.${allowed}`).join(' / ')}（外加不发请求的 llm.settings），` +
        '新增能力请扩展这两个服务而不是再开一套（AGENTS.md §2.7）',
    );
    continue;
  }
  if (declarations.length !== 1) {
    failures.push(
      `provider 名 llm.${name} 的声明者应为 1 个，实际 ${String(declarations.length)} 个：` + declarations.join('、'),
    );
  }
}
// 三个都必须存在：少了任何一个就是「机检在守一条已经不成立的规则」，而不是「仓库变干净了」。
for (const name of [...ALLOWED_PROVIDERS, SETTINGS_PROVIDER]) {
  if (!providerDeclarations.has(name)) failures.push(`provider 名 llm.${name} 一个声明者都没有。`);
}

/**
 * `llm.settings` 的额外一条（spec 7.1-10 的机检化）：连通性测试必须**经 `llm.chat` 要结果**，
 * 所以它不许 import 传输骨架 `http.js`——碰了它就从"配置模块"变成第二个客户端，白名单白开。
 */
for (const file of settingsSources) {
  const importLine = (await readFile(file, 'utf8')).split('\n').find((line) => /['"]\.\/http\.js['"]/.test(line));
  if (importLine) {
    failures.push(
      `llm.settings 的实现 import 了传输骨架：${importLine.trim()}（${relative(file)}）——` +
        '连通性测试请经 `llm.chat.complete()` 要结果（AGENTS.md §2.7 / spec 7.1-10）',
    );
  }
}

if (failures.length) {
  console.error('✖ LLM 入口唯一性检查未通过（spec 2.5-12 / 4.3-07：全仓只允许 packages/llm 够模型）：');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(
  `✔ LLM 入口唯一性检查通过（扫描 ${String(allFiles.length)} 个文件，` +
    `llm.${ALLOWED_PROVIDERS.join(' / llm.')} 各自声明者唯一且未碰传输骨架，模型端点只在 packages/${LLM_PACKAGE}）`,
);
