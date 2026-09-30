/**
 * LLM 入口唯一性机检（spec 2.5-12，AGENTS.md §2.7「禁止第二套 LLM 客户端」的落地）。
 *
 * §2.7 那句禁令隐含一个前提：**第一套得有唯一归属**。不机检的话它必然失守——
 * 2.5 为了话术顺手发一个 `fetch`、P4 生成简历再发一个、P5 的 agent 规划再发一个，
 * 届时谁都不是那「一套」。所以这里只守两件事：
 * 1. 模型端点痕迹（`chat/completions`、已知模型域名、`sk-…` 形态的密钥、模型 SDK 依赖）
 *    只允许出现在 `packages/llm` 里；
 * 2. provider 名 `llm.chat` 全仓只有一个声明者，避免出现第二个平行的「模型服务」。
 *
 * 判定按**字符串字面量**而不是标识符：调用方伪造端点的方式是写一个新 URL，不是改函数名。
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const packagesDir = path.join(repoRoot, 'packages');
/** 唯一的模型出口包：只有这里的源码允许出现下列痕迹。 */
const LLM_PACKAGE = 'llm';

/** 一条「这是在直接够模型」的痕迹特征。 */
const MODEL_TRACES: readonly (readonly [RegExp, string])[] = [
  [/chat\/completions/, 'chat completion 端点路径'],
  [/\/v1\/completions\b/, 'completions 端点路径'],
  [/\b(api\.)?(openai|deepseek|anthropic|moonshot|zhipuai|bigmodel)\.(com|ai|cn)\b/, '已知模型服务域名'],
  [/\bdashscope\.aliyuncs\.com\b/, '已知模型服务域名（DashScope）'],
  // 长度下限 20：真实密钥是这个量级，而 `sk-live-123456` 这类明显的测试假值不该被判成「在够模型」。
  [/\bsk-[A-Za-z0-9_-]{20,}/, '疑似 API key 字面量'],
  [/\bfrom\s+['"](?:openai|@anthropic-ai\/sdk|ollama)['"]/, '模型 SDK 依赖'],
];

const failures: string[] = [];

/**
 * 递归列出目录下的源码文件（跳过构建产物与依赖）。
 * @param dir 起始目录
 * @returns 绝对路径列表
 */
async function filesIn(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && ['node_modules', 'dist', 'out'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await filesIn(full)));
    else if (/\.(ts|tsx|mts|cts|js|json|yml)$/.test(entry.name)) found.push(full);
  }
  return found;
}

/** 相对仓库根的路径，报错时才指得清是哪个文件。 */
const relative = (file: string): string => path.relative(repoRoot, file).replaceAll('\\', '/');

const packageDirs = (await readdir(packagesDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(packagesDir, entry.name));
// `llm` 包自己也要扫：它只能有一个 provider 声明（第二条断言），但豁免端点痕迹（第一条断言）。
const allFiles = (await Promise.all(packageDirs.map((dir) => filesIn(dir).catch(() => [] as string[])))).flat();

const providerDeclarations: string[] = [];

for (const file of allFiles) {
  const source = await readFile(file, 'utf8');
  const isLlmPackage = relative(file).startsWith(`packages/${LLM_PACKAGE}/`);
  source.split('\n').forEach((line, index) => {
    // 注释行不算痕迹：本文件与 spec 文档都要引用这些字样。
    const code = line.replace(/^\s*(?:\/\/|\*|\/\*).*$/, '');
    if (/provide\s*=\s*'llm\.chat'/.test(code)) providerDeclarations.push(`${relative(file)}:${String(index + 1)}`);
    if (isLlmPackage) return;
    for (const [pattern, label] of MODEL_TRACES) {
      if (pattern.test(code)) {
        failures.push(
          `${relative(file)}:${String(index + 1)} 出现${label}：模型调用只允许在 packages/${LLM_PACKAGE} 里发生，` +
            '请改为调用 `llm.chat`（spec 2.5-12）',
        );
      }
    }
  });
}

if (providerDeclarations.length !== 1) {
  failures.push(
    `provider 名 llm.chat 的声明者应为 1 个，实际 ${String(providerDeclarations.length)} 个：` +
      (providerDeclarations.length ? providerDeclarations.join('、') : '（一个都没有）'),
  );
}

if (failures.length) {
  console.error('✖ LLM 入口唯一性检查未通过（spec 2.5-12：全仓只允许 packages/llm 够模型）：');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(
  `✔ LLM 入口唯一性检查通过（扫描 ${String(allFiles.length)} 个文件，llm.chat 声明者唯一，模型端点只在 packages/${LLM_PACKAGE}）`,
);
