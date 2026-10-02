/**
 * 提示词落点唯一性机检（spec 4.6-09，AGENTS.md §8.4 事实锁定的"约束写在哪一句里"的可核对面）。
 *
 * 守两件事：
 * 1. **发给模型的消息字面量**只允许出现在各业务包的 `src/prompts.ts` 里
 *    （判定按形状而不是文件名搜索：消息对象的 `role: 'system'` 那一项。类型标注里的
 *    `role: 'system' | 'user'` 不是字面量，末尾没有逗号，因此不会被误判）；
 * 2. **提示词版本常量**（`*_PROMPT_VERSION`）同样只允许出现在注册表文件里——
 *    版本与文案分家就等于没有版本：改了文案的人看不见常量，复盘时那一列还是旧值。
 *
 * 为什么不禁得这么死：prompt 是本项目唯一一处"用自然语言表达红线"的地方，其余约束都在数据结构里
 * （`Field.locked`、`z.strictObject`、数字多重集守恒）。散在业务文件里时没人逐字读过它，
 * 而 4.6 要往同一张口上再加两类话术——不散管就会变成"谁都能顺手在 service 里拼一句"。
 *
 * 豁免口径（`.test.ts` / `.spec.ts` / `test-doubles.ts` = 只服务于测试的文件）与
 * `scripts/check-llm-single-entry.ts:36` 逐字相同，两处不该各判各的（AGENTS.md §2.5）。
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const packagesDir = path.join(repoRoot, 'packages');

/** 注册表文件的包内相对名：一个包一份，不建跨包注册表（理由见 plan §4.6 取证三）。 */
const REGISTRY_BASENAME = 'prompts.ts';

/** 一条字面量都不许出现在这里的文件（注册表本身除外）。 */
const isTestOnlyModule = (rel: string): boolean =>
  /\.(?:test|spec)\.[cm]?ts$/.test(rel) || rel.endsWith('/test-doubles.ts');

/** 判据特征：① 真的在给模型发消息；② 声明了提示词版本常量。 */
const PROMPT_TRACES: readonly (readonly [RegExp, string])[] = [
  [/role:\s*['"]system['"]\s*(?:as const\s*)?,/, '发给模型的 system 消息字面量'],
  [/^\s*export const [A-Z\d_]*PROMPT_VERSION\b/, '提示词版本常量声明'],
];

const failures: string[] = [];
/** 扫到的注册表文件，用于"规则还成立吗"的反向断言。 */
const registryFiles: string[] = [];

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
    else if (/\.(?:ts|tsx)$/.test(entry.name)) found.push(full);
  }
  return found;
}

/** 相对仓库根的路径，报错时才指得清是哪个文件。 */
const relative = (file: string): string => path.relative(repoRoot, file).replaceAll('\\', '/');

const packageDirs = (await readdir(packagesDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(packagesDir, entry.name));
const allFiles = (await Promise.all(packageDirs.map((dir) => filesIn(dir).catch(() => [] as string[])))).flat();

for (const file of allFiles) {
  const rel = relative(file);
  // 注释行不算痕迹：本文件与各 spec 都要引用这些字样。
  if (rel.endsWith(`/${REGISTRY_BASENAME}`) && rel.startsWith('packages/')) {
    registryFiles.push(rel);
    continue;
  }
  if (isTestOnlyModule(rel)) continue;
  const source = await readFile(file, 'utf8');
  source.split('\n').forEach((line, index) => {
    const code = line.replace(/^\s*(?:\/\/|\*|\/\*).*$/, '');
    for (const [pattern, label] of PROMPT_TRACES) {
      if (pattern.test(code)) {
        failures.push(
          `${rel}:${String(index + 1)} 出现${label}：提示词只允许写在各包的 ` +
            `src/${REGISTRY_BASENAME} 里（spec 4.6-09），请把它移进对应注册表并同步版本号`,
        );
      }
    }
  });
}

// 注册表必须真的存在：一个都没有就是"机检在守一条已经不成立的规则"，而不是"仓库变干净了"。
if (registryFiles.length === 0) {
  failures.push(
    `一个 ${REGISTRY_BASENAME} 注册表都没有：至少 ` + '`packages/outbound` 与 `packages/resume-kb` ' + '各需一份。',
  );
}

if (failures.length) {
  console.error(`✖ 提示词落点检查未通过（spec 4.6-09：提示词与版本常量只允许在各包的 src/${REGISTRY_BASENAME}）：`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(
  `✔ 提示词落点检查通过（扫描 ${String(allFiles.length)} 个源码文件，` +
    `注册表 ${String(registryFiles.length)} 份：${registryFiles.join('、')}）`,
);
