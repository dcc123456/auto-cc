/**
 * 合规护栏机检（spec 2.7-02 / 2.7-04 / 5.6-05 / 5.6-06，AGENTS.md §8.1/§8.3/§8.5 的落地）。
 *
 * 四条规则、四种失效模式：
 * 1. **红线**（2.7-02）：验证码识别、UA 与指纹伪装、请求头改写、多账号分区池——这四类一旦进了代码库，
 *    就不再是"某个人的坏主意"而是"这个项目支持的用法"，所以按**字符串痕迹**扫（要绕过它得改的是意图，不是标识符）。
 * 2. **节奏数**（2.7-04）：等间隔是机器行为（AGENTS.md §8.3），而"从配置读一个定值再固定地睡"同样是机器行为。
 *    所以这条规则只认得"数值得从配置来"这一件事：出现在 `sleep(` / `setTimeout(` / `setInterval(` 实参位置上的
 *    数字字面量一律失败，`*.default()` 里的默认值与具名常量不在它的射程内。
 * 3. **测试面 URL**（4.4-08 / AGENTS.md §7.2）：自动化不许碰真实招聘平台。这条只扫**测试与脚本面**
 *    （理由见下面的 `TEST_SURFACE`），主机名只许是回环、RFC 保留名，或写进 allowlist 并说明理由的真实域名。
 * 4. **两道脱敏边界**（5.6-05 / 5.6-06 / §8.5）：个人数据只有两个出界口——进对话记录之前、出网络之前。
 *    这条只判"那两处还在不在调用 core 的那一份 redact"，遮得对不对由 `agent.test.ts` / `llm.test.ts`
 *    的含 PII 剧本用例判（机检查得出结构缺席，查不出语义）。
 *
 * 判定按行而不是 AST：本仓已有的同类检查（`check-llm-single-entry.ts`）就是这个形状，
 * 换 AST 要为四条规则引入一个解析器依赖，不值。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { filesIn, packageDirs, relative, repoRoot } from './internal/scan.js';

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

/**
 * 规则三放行的真实域名：**每条都必须带一句"这里为什么可以出现真实域名"**。
 *
 * 这两处都不是"被请求的地址"而是"被判读的字符串"：
 * - `schemas.openxmlformats.org` 是 OOXML 的 XML 命名空间标识符，docx 解析用例拿它比对字符串常量；
 * - `zhipin.com` 出现在**拒绝路径**上——导航策略要判「这个域名不属于任何已登记平台」，
 *   知识包契约用例把它当 `startUrl` 字段的值喂给校验器。判"会不会被拒绝"必须拿真域名，
 *   换成 `*.invalid` 就把要检的那件事本身检掉了（spec 2.2-08 / 2.7 的判据）。
 * 加新条目的门槛：先确认这段代码真的不发请求，否则该改的是用例，不是这张表。
 */
const TEST_REAL_HOST_ALLOWLIST: readonly (readonly [RegExp, string])[] = [
  [/^schemas\.openxmlformats\.org$/, 'OOXML 命名空间标识符（只比对字符串，不发请求）'],
  [
    /^(?:www\.)?zhipin\.com$/,
    '导航策略与知识包契约用例里的"被判定字符串"（许可名单与包数据都取真域名才判得出两侧：已登记源放行 / 未登记源仍拒）。P8 8.1 起真实域名也是发布包的取值面，但**测试面判据不变**：这些用例不发请求、不 attach 真 target，自动化仍然只打 10233',
  ],
];

/** 边界文件必须从 `@auto-cc/core` 把 redact 那一份请进来（跨行的 `import { … }` 也算）。 */
const CORE_REDACT_IMPORT = /import\s*\{[^}]*\bredact[A-Z]\w*[^}]*\}\s*from ['"]@auto-cc\/core['"]/;

/**
 * 规则四：个人数据出界的两道边界，各有一处必须还在调用 core 那一份 redact（spec 5.6-05 / 5.6-06）。
 *
 * 为什么只做"调用点还在不在"这一层：机检查得出结构缺席，查不出语义——`redactText(clip(x))` 这种
 * 遮了半个字段的写法要靠用例判，而「一次重构把落库前的那句遮掉换成原样递进去」正是本条能当场拦住的形态。
 * 落点选在**边界文件**而不是"整个 agent 包不许出现原文"：`plan_json` 那类执行件必须留原文才能重跑
 * （plan §7.4 决策一的反向半边），按包扫会把正确的例外一起误伤，逼人在检查里堆豁免表。
 */
const PII_BOUNDARIES: readonly (readonly [file: string, call: RegExp, boundary: string])[] = [
  ['packages/agent/src/session.ts', /\bredact(?:Text|Value)\s*\(/, '消息正文与工具卡片进对话记录之前'],
  ['packages/llm/src/index.ts', /\bredactText\s*\(/, 'messages 正文出网之前'],
];

/** 回环地址：`127.0.0.0/8` 与 `localhost` / `::1`，本地 fixture 站点与 CDP 都住在这里。 */
const LOOPBACK_HOST = /^(?:127\.(?:\d{1,3}\.){2}\d{1,3}|localhost|::1)$/;

/** RFC 2606 / 6761 保留名（含 `model.test.invalid` 这类多级写法），公网不可达。 */
const RESERVED_NAME = /(?:^|\.)(?:invalid|test|localhost|example)$/;

/** RFC 2606 保留的文档用域名（`fixture.example.com` 这类测试数据常用它）。 */
const RESERVED_DOC_DOMAIN = /(?:^|\.)example\.(?:com|org|net)$/;

const failures: string[] = [];

/** 红线痕迹的射程：TS 全家加 `.js`（脚本面与构建配置里也可能藏着改写请求的代码）。 */
const isSourceFile = (name: string): boolean => /\.(ts|tsx|mts|cts|js)$/.test(name);

/** 按上面的口径列出一个目录下的源码文件。 */
const filesInSource = (dir: string): Promise<string[]> => filesIn(dir, isSourceFile);

const isTestFile = (rel: string): boolean => /\.(test|spec)\.ts$/.test(rel) || rel.endsWith('/test-doubles.ts');

/**
 * 规则三的射程：测试面 + 脚本面 + CDP harness 所在的 `packages/testing`。
 *
 * **刻意不扫生产代码**：这个 app 的本职工作就是驱动真实招聘站，`packages/browser` 里出现
 * `zhipin.com` 是产品形态而不是违规（那部分由 `entitlement.gate`、风控停机和 ToS 确认三件事管）。
 * 违规只有一种形态：**自动化路径**把真实平台当成了被测目标——那种代码一定住在上面这几处。
 */
const TEST_SURFACE = (rel: string): boolean =>
  isTestFile(rel) || rel.startsWith('packages/testing/') || rel.startsWith('scripts/');

/**
 * 判一个 URL 主机名能不能出现在规则三的射程里。
 * @param rawHost 去掉协议后的主机段（可能带端口、可能带 `user@`、也可能是 `${host}` 插值）
 * @returns 允许返回 null；不允许返回一句可直接打印的违规说明
 */
function hostViolation(rawHost: string): string | null {
  // 主机名来自变量时字符串面判不了（`http://${host}:${port}`）。这不是漏洞：同一件事的另一半
  // 由 `CdpSession.navigate` 的运行期 loopback 守卫兜住（plan §4.4-e 判据二），那里变量已经落成实值。
  if (rawHost.includes('${')) return null;
  const withoutCredentials = rawHost.split('@').pop() ?? rawHost;
  const bracketed = /^\[(.*?)(?:\]|:)/.exec(withoutCredentials);
  const host = (bracketed?.[1] ?? withoutCredentials.split(':')[0] ?? '').toLowerCase().replace(/\.$/, '');
  if (!host) return null;
  if (LOOPBACK_HOST.test(host)) return null;
  if (RESERVED_NAME.test(host) || RESERVED_DOC_DOMAIN.test(host)) return null;
  // 单标签主机名（用例里的 `http://top`、`http://x`）不是可注册域名，DNS 上都到不了站。
  if (!host.includes('.')) return null;
  const allowed = TEST_REAL_HOST_ALLOWLIST.find(([pattern]) => pattern.test(host));
  if (allowed) return null;
  return (
    `测试/脚本面出现了真实域名「${host}」：自动化一律只许打本地 fixture（127.0.0.1 / localhost）或` +
    ' RFC 保留名（*.invalid / *.test / *.example），真实招聘平台只在用户在场时手动验证' +
    '（spec 4.4-08 / AGENTS.md §7.2）。确属"被判读的字符串而非被请求的地址"才允许加进 ' +
    'TEST_REAL_HOST_ALLOWLIST，并写清理由'
  );
}

/**
 * 扫一个文件里的 URL 字面量，把违规写进 `failures`。
 *
 * 抽成函数是因为射程跨两个循环（`packages/*` 与 `scripts/`），而 §2.2 不允许同一个判定写两遍。
 * @param rel 相对仓库根的路径
 * @param lines 文件按行切开的内容
 */
function scanTestSurfaceHosts(rel: string, lines: string[]): void {
  if (!TEST_SURFACE(rel)) return;
  lines.forEach((line, index) => {
    // 注释里的 URL 不参与判定：注释发不出请求，而本仓的 JSDoc 惯例是把真实端点写清楚当证据（§6.1）。
    const code = line.replace(/^\s*(?:\/\/|\*|\/\*).*$/, '');
    // 主机名到 CJK 标点为止：本仓的判据字符串是中文，紧跟在地址后的全角括号与「」不是主机名字符，
    // 把它们算进主机段就匹配不上许可名单，于是"被判定字符串"会被当成违规地址假报一次。
    for (const match of code.matchAll(/(?:https?|wss?):\/\/([^\s'"`/?#\\\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]+)/g)) {
      const violation = hostViolation(match[1] ?? '');
      if (violation) failures.push(`${rel}:${String(index + 1)} ${violation}`);
    }
  });
}

const scannedPackages = await Promise.all(
  (await packageDirs()).map(async (dir) => ({
    name: path.basename(dir),
    files: await filesInSource(dir).catch(() => [] as string[]),
  })),
);

for (const { name, files } of scannedPackages) {
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

    // —— 规则三：测试与脚本面的 URL 主机名（先看，别被下面规则二的 continue 跳过）——
    scanTestSurfaceHosts(rel, lines);

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

// 规则三还要覆盖 `scripts/**`：上面的循环只遍历 packages，而 fixture 服务与验收脚本才是真的会起进程、
// 真的会被人手跑起来打网络的那一层（§7.2 禁的是"自动化访问真实平台"，脚本面首当其冲）。
const scriptFiles = await filesInSource(path.join(repoRoot, 'scripts')).catch(() => [] as string[]);
for (const file of scriptFiles) {
  scanTestSurfaceHosts(relative(file), (await readFile(file, 'utf8')).split('\n'));
}

// —— 规则四：两道脱敏边界的调用点（5.6-05 落库前 / 5.6-06 出站前）——
for (const [file, call, boundary] of PII_BOUNDARIES) {
  const source = await readFile(path.join(repoRoot, file), 'utf8').catch(() => null);
  if (source === null) {
    failures.push(`${file} 读不到：「${boundary}」这道边界没有落点，个人数据会原样出去（spec 5.6-05 / 5.6-06）`);
    continue;
  }
  if (!call.test(source)) {
    failures.push(
      `${file} 里没有 redact 调用：「${boundary}」这道边界失效，手机号/邮箱/证件号会原样进存储或出网` +
        '（spec 5.6-05 / 5.6-06、AGENTS.md §8.5）',
    );
  } else if (!CORE_REDACT_IMPORT.test(source)) {
    failures.push(
      `${file} 的脱敏调用不是从 @auto-cc/core 请进来的：那是第二套 PII 正则，` +
        '遮出来的形状会与 logger、证据文本（2.7-d）、KB 入库（4.1-09）那几处不一致（AGENTS.md §2.5 / §2.7）',
    );
  }
}

if (failures.length) {
  console.error(
    '✖ 合规护栏机检未通过（spec 2.7-02 红线 / 2.7-04 节奏数 / 4.4-08 测试面 URL / 5.6-05 与 5.6-06 两道脱敏边界）：',
  );
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(
  `✔ 合规护栏机检通过（扫描 ${String(scannedPackages.reduce((sum, entry) => sum + entry.files.length, 0) + scriptFiles.length)} 个源码文件：` +
    `无 UA/指纹/打码/自定义分区痕迹，${PACING_PACKAGES.join('/')} 的节奏数值全部来自配置，` +
    `测试与脚本面的 ${String(TEST_REAL_HOST_ALLOWLIST.length)} 条真实域名豁免之外没有出网地址，` +
    `${PII_BOUNDARIES.map(([file]) => file).join(' 与 ')} 的两道脱敏边界都在调用 core 那一份 redact）`,
);
