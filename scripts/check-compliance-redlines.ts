/**
 * 合规护栏机检（spec 2.7-02 / 2.7-04，AGENTS.md §8.1/§8.3 的落地）。
 *
 * 两条规则、两种失效模式：
 * 1. **红线**（2.7-02）：验证码识别、UA 与指纹伪装、请求头改写、多账号分区池——这四类一旦进了代码库，
 *    就不再是"某个人的坏主意"而是"这个项目支持的用法"，所以按**字符串痕迹**扫（要绕过它得改的是意图，不是标识符）。
 * 2. **节奏数**（2.7-04）：等间隔是机器行为（AGENTS.md §8.3），而"从配置读一个定值再固定地睡"同样是机器行为。
 *    所以这条规则只认得"数值得从配置来"这一件事：出现在 `sleep(` / `setTimeout(` / `setInterval(` 实参位置上的
 *    数字字面量一律失败，`*.default()` 里的默认值与具名常量不在它的射程内。
 *
 * 判定按行而不是 AST：本仓已有的同类检查（`check-llm-single-entry.ts`）就是这个形状，
 * 换 AST 要为两条规则引入一个解析器依赖，不值。
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const packagesDir = path.join(repoRoot, 'packages');

/** 规则一：一条「这是在绕过风控而不是停下来」的痕迹。 */
const REDLINES: readonly (readonly [RegExp, string])[] = [
  [/\b(overrideUserAgent|appendUserAgent|setUserAgent)\b/, '改写 User-Agent（指纹伪装）'],
  [/\bwebRequest\.onBefore(SendHeaders|Request|Response)\b/, '改写请求/响应通道的 webRequest 钩子'],
  [/\bextraHeaders\b/, '随请求附加自定义头'],
  [/\bnavigator\s*\.\s*webdriver\b/, '页面里抹 webdriver 痕迹'],
  [
    /\b(addScriptToEvaluateOnNewDocument|Page\.addScriptToEvaluateOnNewDocument|evaluateOnNewDocument)\b/,
    '文档创建前注入脚本（指纹注入通道）',
  ],
  [/\bObject\.defineProperty\(\s*navigator\b/, '改写 navigator 属性'],
  [/\b(2captcha|anticaptcha|capmonster|deathbycaptcha|scratch-captcha)\b/i, '第三方打码/验证码识别服务'],
];

/**
 * 规则一的豁免：分区名的**唯一定义处**与测试替身。
 *
 * `persist:<platform>` 这件事必须有人写出来（它是登录态接管的地基），所以红线只拦"凭空多写一份分区"：
 * 定义在 `shared/bridge.ts`，其余地方一律经 `partitionFor()` 拼；测试替身与单测里的假分区不算池子。
 */
const PARTITION_ALLOWED: readonly string[] = ['packages/shared/src/bridge.ts'];

/** 规则二覆盖的包：会真的去碰页面、真的会向外发的这几层。 */
const PACING_PACKAGES = ['browser', 'outbound', 'platform-boss', 'workflow', 'agent'];

/**
 * 规则二的豁免：非节奏用途的定值等待。
 *
 * `agent/session.ts` 的流式分片间隔、以及任何写在 zod `.default()` 里的默认值都不算命中；
 * 这里的每条豁免都要能一句话说清"它不是站点看到的操作节奏"，否则就该搬进配置。
 */
const PACING_ALLOWLIST: readonly RegExp[] = [/\.default\(/, /MAX_[A-Z_]*MS\b/];

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
    else if (/\.(ts|tsx|mts|cts|js)$/.test(entry.name)) found.push(full);
  }
  return found;
}

/** 相对仓库根、正斜杠的路径，报错时才指得清是哪个文件。 */
const relative = (file: string): string => path.relative(repoRoot, file).replaceAll('\\', '/');

const isTestFile = (rel: string): boolean => /\.(test|spec)\.ts$/.test(rel) || rel.endsWith('/test-doubles.ts');

const packageDirs = await Promise.all(
  (await readdir(packagesDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => ({
      name: entry.name,
      files: await filesIn(path.join(packagesDir, entry.name)).catch(() => [] as string[]),
    })),
);

for (const { name, files } of packageDirs) {
  for (const file of files) {
    const rel = relative(file);
    const source = await readFile(file, 'utf8');
    const lines = source.split('\n');

    // —— 规则一：红线痕迹（测试文件也要扫：绕过风控的实现不会自称是测试）——
    lines.forEach((line, index) => {
      const code = line.replace(/^\s*(?:\/\/|\*|\/\*).*$/, '');
      for (const [pattern, label] of REDLINES) {
        if (pattern.test(code)) {
          failures.push(
            `${rel}:${String(index + 1)} 出现${label}：检测到风控信号只能**停下来**，不做识别与规避（spec 2.7-02 / AGENTS.md §8.3）`,
          );
        }
      }
      if (/['"`]persist:/.test(code) && !PARTITION_ALLOWED.includes(rel) && !isTestFile(rel)) {
        failures.push(
          `${rel}:${String(index + 1)} 直接写死了会话分区名：分区只能由 partitionFor(平台标识) 拼出来，` +
            '手搓第二个同名分区就是多账号池的雏形（spec 2.7-02）',
        );
      }
    });

    // —— 规则二：节奏数字面量（只看生产代码）——
    if (!PACING_PACKAGES.includes(name) || isTestFile(rel)) continue;
    lines.forEach((line, index) => {
      const code = line.replace(/^\s*(?:\/\/|\*|\/\*).*$/, '');
      const callStart = /\b(?:sleep|setTimeout|setInterval)\s*\(/.exec(code);
      if (!callStart) return;
      // 延时实参常常换行（`setTimeout(() => {...}, ms)`），所以取调用点起 4 行做窗口。
      const callWindow = lines
        .slice(index, index + 4)
        .join('\n')
        // 注入脚本里的 `${...}` 是把配置值插进模板，窗口内的字面量属于模板文本，不算代码里的定值。
        .replace(/\$\{[^}]*\}/g, '${x}');
      // 命中形状只有两种：`sleep(300…` 与 `…, 300)`——数字出现在实参位置上。
      if (!/[,(]\s*\d{2,}\s*[,)]/.test(callWindow)) return;
      if (PACING_ALLOWLIST.some((allowed) => allowed.test(callWindow))) return;
      failures.push(
        `${rel}:${String(index + 1)} 把节奏数值写成了字面量：停顿毫秒数必须从配置或节流服务来，` +
          '写死就等于放弃随机化（spec 2.7-04）',
      );
    });
  }
}

if (failures.length) {
  console.error('✖ 合规护栏机检未通过（spec 2.7-02 红线 / 2.7-04 节奏数）：');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(
  `✔ 合规护栏机检通过（扫描 ${String(packageDirs.reduce((sum, entry) => sum + entry.files.length, 0))} 个源码文件：` +
    `无 UA/指纹/打码/自定义分区痕迹，${PACING_PACKAGES.join('/')} 的节奏数值全部来自配置）`,
);
