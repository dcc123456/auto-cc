/**
 * 生产依赖许可证扫描与记账机检（spec 5.9-04，plan §7.7.3 切片 5.9-c）。
 *
 * 为什么常驻在 `pnpm lint` 链里而不是一次人肉核对：许可证记账的失效模式和依赖膨胀一模一样——
 * **某次顺手 `pnpm add`**。今天这张表是干净的，明天加一个 AGPL 的 PDF 引擎，
 * 「随包分发要附 NOTICE / 要写明 copyleft 义务」这件事如果只写在文档里，就一定会有人不知道（§8.7）。
 *
 * 四件事，缺一件都会漏：
 * 1. **取数**：`pnpm licenses list --json --prod`（pnpm 自带的许可聚合口）。不自己实现依赖解析——
 *    那是第二套真相源（§2.7），而且 pnpm 的解析与安装事实同源。
 * 2. **搬运层交叉核对**：`resolveRuntimeDeps()`（esbuild 外置依赖的唯一真相源，1.7-15 / 5.9-a 读的也是它）
 *    里的每一个包都必须出现在许可表里。这一条挡的是"进了 asar 却没进记账"，两者不同源就一定会漂。
 * 3. **copyleft 闸门**：许可串命中 AGPL / LGPL / GPL-3 / SSPL / QPL / CDDL / MPL 的包，
 *    必须在本文件的 `COPYLEFT_DISPOSITIONS` 里有一条**处置原话**（随包 NOTICE / 只用宽松许可分支 / 不引入），
 *    新出现的没有处置即失败。双许可（如 jszip 的 `MIT OR GPL-3.0-or-later`）也走这里——
 *    "我们取哪一支"是决定，要写下来，不能让下一个人重新猜。
 *    同一条还核对**搬运层每个包目录里带着许可全文**——扫描只证明"知道是什么许可"，
 *    分发义务要证明"条文真的跟着包走了"（Apache-2.0/BSD 都是"保留"类许可）。
 * 4. **文档对齐**：`LICENSES.md` 里 `<!-- BEGIN/END:generated -->` 之间的那一节由本脚本生成，
 *    与当前扫描结果逐字比对，漂了就失败并提示 `--write`。文档不再手抄依赖表，抄一次错一次。
 *
 * 随包运行时（electron 本体与它自带的 Chromium/V8 许可）不在 `--prod` 闭包里——它是 devDependency
 * 却百分百进产物，所以单独读它的 manifest 登记，并核对产物目录里 electron-builder 自动放置的
 * `LICENSE.electron.txt` / `LICENSES.chromium.html`（产物没构建时跳过并打印原因，不假装验过）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  findLicenseFileIn,
  type VendoredDep,
  resolveRuntimeDeps,
  THIRD_PARTY_NOTICES_FILE,
} from './vendor-runtime-deps.js';

/** 仓库根（本文件在 `scripts/` 下）。 */
const repoRoot = path.resolve(import.meta.dirname, '..');

/** 许可证记账文档。 */
const LICENSE_DOC = path.join(repoRoot, 'LICENSES.md');

/** 生成节的两个锚点，脚本只认这一对，别的正文一个字都不动。 */
const BEGIN = '<!-- BEGIN:generated-by-check-licenses -->';
const END = '<!-- END:generated-by-check-licenses -->';

/** pnpm 许可聚合口给出的包条目（只取本脚本要用的字段）。 */
interface LicenseEntry {
  name: string;
  versions: string[];
  license: string;
}

/**
 * copyleft / 双许可的处置表（键 = 包名）。
 *
 * 判据不是"有没有 GPL 字样"而是"随包分发时我们欠什么"：命中闸门却没在这里登记 = 没人想过这件事，
 * 那正是 §8.7 要拦的状态。新增条目时必须同时写清义务，空话视为未登记。
 */
const COPYLEFT_DISPOSITIONS: Readonly<Record<string, string>> = {
  jszip:
    '双许可 `(MIT OR GPL-3.0-or-later)`：**取 MIT 那一支**（mammoth 的依赖，随 asar 分发）。' +
    'MIT 分支无 NOTICE 义务；此条存在的意义是防止下一个人看到 GPL-3 字样就以为整个 app 被传染。',
};

/** 命中即要求登记处置的许可串形状（宽松许可 OR 严格许可的双许可同样命中，见上表）。 */
const COPYLEFT_PATTERN = /(AGPL|LGPL|GPL-3|GPLv3|SSPL|QPL|CDDL|MPL|CECILL)/i;

/**
 * 平台专属可选二进制包的名字形状（`@napi-rs/canvas-darwin-arm64`、`lightningcss-win32-x64-msvc` 这类）。
 *
 * 为什么单把它们挑出来：`pnpm licenses list` 读的是**本机安装树**，可选依赖只装当前平台那一份，
 * 于是同一份 lockfile 在 win / mac / linux 上扫出来的表逐行差一行——记账文档因此逐台漂，
 * `pnpm lint` 在换宿主的当天必红（本项目 2026-10-04 起在 macOS 上撞的就是这一条）。
 * 省掉的只是**记账行**（父包那一行已经把名字 / 版本 / 许可都记了），不是检查：
 * copyleft、非商用、搬运层在册三道闸门仍旧扫**全部**条目，含这些平台包。
 */
const PLATFORM_OPTIONAL_PATTERN =
  /-(darwin|win32|linux|freebsd|android|netbsd|openbsd)-(x64|ia32|arm64|arm|universal|riscv64|ppc64|s390x|mips)(-.*)?$/;

/**
 * 把扫描结果分成「进记账表的」与「平台专属可选包」。
 * @param entries 全量扫描条目（三道闸门用的就是这份全量）
 * @returns `table` 进文档的条目，`platformOnly` 被父包行代表、不单独进表的那些
 */
function splitPlatformOptional(entries: readonly LicenseEntry[]): {
  table: LicenseEntry[];
  platformOnly: LicenseEntry[];
} {
  const table: LicenseEntry[] = [];
  const platformOnly: LicenseEntry[] = [];
  for (const entry of entries) (PLATFORM_OPTIONAL_PATTERN.test(entry.name) ? platformOnly : table).push(entry);
  return { table, platformOnly };
}

/**
 * 跑 `pnpm licenses list --json --prod` 并解析成扁平条目列表。
 * @returns 按「许可 → 包」分组展平后的条目（已按许可、包名排序，输出稳定可 diff）
 * @throws pnpm 不可用或输出不是合法 JSON 时抛错——宁可不通过，也不要把"没扫到"当成"没有依赖"
 */
function scanProductionLicenses(): LicenseEntry[] {
  const result = spawnSync('pnpm', ['licenses', 'list', '--json', '--prod'], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0 && !result.stdout.trim().startsWith('{')) {
    throw new Error(`pnpm licenses list 失败（exit ${String(result.status)}）：${result.stderr.slice(0, 400)}`);
  }
  const jsonText = result.stdout.slice(result.stdout.indexOf('{'));
  const grouped = JSON.parse(jsonText) as Record<string, Record<string, LicenseEntry>>;
  const entries: LicenseEntry[] = [];
  for (const [license, packages] of Object.entries(grouped)) {
    for (const entry of Object.values(packages)) {
      entries.push({ name: entry.name, versions: entry.versions ?? [], license });
    }
  }
  return entries.sort((a, b) => a.license.localeCompare(b.license) || a.name.localeCompare(b.name));
}

/**
 * 读随包运行时 electron 自身的许可与版本（它不在 `--prod` 里，但一定进产物）。
 * @returns `{ name, version, license }`；本机没装 electron 时返回 null（调用方按"没验过"处理）
 */
function readElectronRuntime(): { version: string; license: string } | null {
  const manifestPath = path.join(repoRoot, 'packages', 'main', 'node_modules', 'electron', 'package.json');
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: string; license?: string };
  return { version: manifest.version ?? '(未知)', license: manifest.license ?? '(未声明)' };
}

/**
 * 生成 `LICENSES.md` 里那一节的正文。
 * @param entries 生产依赖条目（已排序）
 * @param electron 随包运行时读数，可为 null
 * @param missingLicenseText 搬运层里包目录没有许可全文的包名
 * @returns 锚点之间的完整 markdown（含汇总、生产依赖表、运行时行、copyleft 处置表、缺全文处置表）
 */
function renderGenerated(
  entries: LicenseEntry[],
  electron: { version: string; license: string } | null,
  missingLicenseText: readonly string[],
): string {
  const byLicense = new Map<string, number>();
  for (const entry of entries) byLicense.set(entry.license, (byLicense.get(entry.license) ?? 0) + 1);
  const copyleftHits = entries.filter((entry) => COPYLEFT_PATTERN.test(entry.license));
  const runtimeRow =
    electron === null
      ? '| electron（随包运行时） | （本机未安装，未核对） | — | — |\n'
      : `| electron（随包运行时，非 \`--prod\` 闭包） | ${electron.version} | ${electron.license} |` +
        ' 产物内附 `LICENSE.electron.txt` 与 `LICENSES.chromium.html`（electron-builder 自动放置，本机实测在包内） |';
  const dispositionRows = Object.entries(COPYLEFT_DISPOSITIONS)
    .map(([name, note]) => `| \`${name}\` | ${note} |`)
    .join('\n');
  const missingTextRows = Object.entries(MISSING_LICENSE_TEXT_DISPOSITIONS)
    .map(([name, note]) => `| \`${name}\` | ${note} |`)
    .join('\n');
  return [
    '> 本节由 `tsx scripts/check-licenses.ts --write` 生成，请勿手改；正文其余部分是人工记账。',
    `> 取数口：\`pnpm licenses list --json --prod\`（与安装事实同源，不另写依赖解析）。`,
    '',
    `**生产依赖合计 ${String(entries.length)} 个包条目**，按许可分组：`,
    '',
    '| 许可 | 包数 |',
    '| ---- | ---- |',
    ...[...byLicense.entries()].sort((a, b) => b[1] - a[1]).map(([lic, n]) => `| ${lic} | ${String(n)} |`),
    '',
    '**逐包清单**（版本 = 锁定的实际解析版本）：',
    '',
    '| 包 | 版本 | 许可 |',
    '| -- | ---- | ---- |',
    ...entries.map((e) => `| \`${e.name}\` | ${e.versions.join(' / ') || '(未知)'} | ${e.license} |`),
    '',
    '**平台专属可选包的记账口径（2026-10-05 登记，见 plan §7.7.3 的 5.9-c 补记）**：' +
      '名字以 `-<平台>-<架构>` 结尾的可选二进制包（`@napi-rs/canvas-darwin-arm64` 这类）**不进上面的表**——' +
      '`pnpm licenses list` 读的是本机安装树，可选依赖只装当前平台那一份，' +
      '把它们写进文档会让同一份 lockfile 在 win / mac / linux 上各生成一行不同的记录，' +
      '记账表因此逐台漂、`pnpm lint` 在换宿主的当天必红。' +
      '它们的许可与版本由**父包那一行**代表（`@napi-rs/canvas` 就在表里），' +
      '而 copyleft 闸门、非商用闸门、搬运层在册核对**仍旧扫全量条目**（含这些平台包）：' +
      '这里省的是记账行，不是检查。',
    '',
    '**随包运行时**：',
    '',
    '| 项 | 版本 | 许可 | 义务与处置 |',
    '| -- | ---- | ---- | ---------- |',
    runtimeRow,
    '',
    `**copyleft / 双许可闸门命中 ${String(copyleftHits.length)} 条**，处置如下（新增命中而未登记即 ` +
      '`pnpm lint` 失败）：',
    '',
    '| 包 | 处置 |',
    '| -- | ---- |',
    dispositionRows,
    '',
    `**搬运层缺许可全文的包 ${String(missingLicenseText.length)} 个**（上游发布物本身没有 LICENSE 文件，` +
      '义务由产物内的 ' +
      '`' +
      THIRD_PARTY_NOTICES_FILE +
      '` 按 manifest 登记承接；两者都走 `pnpm lint` 闸门）：',
    '',
    '| 包 | 处置 |',
    '| -- | ---- |',
    missingTextRows,
  ].join('\n');
}

/**
 * 上游发布物里没有许可全文的包（键 = 包名，值 = 处置原话）。
 *
 * 有这一张表不是为了放行，而是为了**把缺口写在一个必须被人读到的地方**：这类包的义务由
 * `emitThirdPartyNotices()` 生成的 `THIRD-PARTY-NOTICES.txt` 承接（按 manifest 的 license/author/repository
 * 登记，随 extraResources 进安装目录）。新增命中而未登记 = 没人想过 = lint 失败。
 */
const MISSING_LICENSE_TEXT_DISPOSITIONS: Readonly<Record<string, string>> = {
  isarray:
    '`isarray@1.0.0` 的 npm 发布物内只有 Makefile/README/component.json/index.js/package.json/test.js，' +
    '**没有 LICENSE 文件**（实测）。许可字段是 MIT、作者是 package.json 里的 Julian Gruber，' +
    '义务由 `THIRD-PARTY-NOTICES.txt` 按 manifest 登记承接；不从网络补抄条文——那是凭记忆生成许可文本，比登记缺口更危险。',
  'lazy-val':
    '`lazy-val@1.0.5`（electron-updater 带进来的）发布物内只有 out/、package.json、readme.md，' +
    '**没有 LICENSE 文件**（实测）。许可字段是 MIT、作者是 package.json 里的 Vladimir Krivosheev，' +
    '处置与 isarray 同一条：由 `THIRD-PARTY-NOTICES.txt` 按 manifest 登记，不从网络补抄条文。',
};

/**
 * 核对搬运层每个包目录里**真的带着许可全文**（spec 5.9-04 的"NOTICE 明确记录"半边）。
 *
 * 为什么单查这一层：`mammoth` / `pdfjs-dist` 及其依赖树是 esbuild 外置后**整包拷进产物**的
 * （`app.asar.unpacked`），许可义务（Apache-2.0 要保留 LICENSE 与 NOTICE、BSD 要保留全文）
 * 落在这份拷贝上；pnpm 的扫描只证明"知道它是什么许可"，不证明"分发时把条文带上了"。
 * @param deps 搬运层读数（`dir` = 包目录的真实路径）
 * @returns 缺全文的包名列表（空 = 都带上了）
 */
function findVendoredPackagesMissingLicenseText(deps: readonly VendoredDep[]): string[] {
  return deps.filter((dep) => findLicenseFileIn(dep.dir) === null).map((dep) => dep.name);
}

/**
 * 比对用的归一化：逐行去首尾空白、把连续空格压成一个、丢掉空行。
 *
 * 为什么不逐字比：`pnpm format` 的 prettier 会重排 markdown 表格的列宽（补空格对齐竖线，
 * **分隔行的连字符长度也跟着变**），于是"脚本刚生成的那一节"和"被格式化工具碰过的那一节"
 * 永远逐字不等——那条闸门就会退化成"每次 format 后都得重跑 --write"的假阳性（本轮真的撞上了）。
 * 表格的**内容**才是记账，列宽与分隔行的连字符不是。
 * @param text 待比较的 markdown 片段
 * @returns 只保留内容差异的规范化文本
 */
function normalizeMarkdown(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim().replace(/\s+/g, ' '))
      // 表格分隔行（只由 `|` `-` `:` 和空格组成）压成一个哨兵，连字符长度不参与比对
      .map((line) => (/^\|[\s:|-]+$/.test(line) ? '|' : line))
      .filter((line) => line.length > 0)
      .join('\n')
  );
}

/** 模式：`--write` 重写文档那一节，默认只校验。 */
const writeMode = process.argv.includes('--write');

const failures: string[] = [];
const entries = scanProductionLicenses();
const scannedNames = new Set(entries.map((entry) => entry.name));
const electron = readElectronRuntime();
// 记账表只放平台无关的那部分（口径见 `PLATFORM_OPTIONAL_PATTERN` 的注释），三道闸门用全量 `entries`。
const { table: tableEntries, platformOnly } = splitPlatformOptional(entries);
if (platformOnly.length > 0) {
  console.log(
    `  · 本机扫到 ${String(platformOnly.length)} 条平台专属可选包（${platformOnly
      .map((entry) => `${entry.name}@${entry.versions.join('/') || '未知版本'}`)
      .join('、')}），按登记的口径由父包行代表、不进记账表；copyleft / 非商用 / 搬运层三道闸门仍按全量核对`,
  );
}

// 2. 搬运层交叉核对：进了 asar 的包必须在这张表里。
const vendored = resolveRuntimeDeps();
const missingFromScan = vendored.filter((dep) => !scannedNames.has(dep.name)).map((dep) => dep.name);
if (missingFromScan.length > 0) {
  failures.push(`搬运层有 ${String(missingFromScan.length)} 个包不在许可扫描结果里：${missingFromScan.join(', ')}`);
}

// 3. copyleft 闸门。
const hitNames = new Set(entries.filter((entry) => COPYLEFT_PATTERN.test(entry.license)).map((entry) => entry.name));
const undocumented = [...hitNames].filter((name) => COPYLEFT_DISPOSITIONS[name] === undefined);
if (undocumented.length > 0) {
  failures.push(`以下包命中 copyleft 闸门但没有处置登记：${undocumented.join(', ')}`);
}
const stale = Object.keys(COPYLEFT_DISPOSITIONS).filter((name) => !hitNames.has(name));
if (stale.length > 0) {
  failures.push(`处置表里有 ${stale.length} 条已经没有对应的包（${stale.join(', ')}），删掉以免误导`);
}

// 3.5 非商用许可闸门（spec 5.10-15）。
//     copyleft 那一档"登记处置就放行"，这一档不行：app 是商用分发的桌面产品，
//     PolyForm-Noncommercial / CC BY-NC 一类**没有可以买的处置**，命中即必须换依赖。
//     触发它的是源仓库 browser-copilot 自己的 PolyForm-NC 立场——那条豁免只覆盖用户原创部分，
//     真把它的依赖搬进来就会在这里红，而不是等发布前才发现。
const NONCOMMERCIAL_PATTERN = /(NonCommercial|BY-NC|NC[-\s]?1\.0|CC-BY-NC)/i;
const nonCommercialHits = entries.filter((entry) => NONCOMMERCIAL_PATTERN.test(entry.license));
if (nonCommercialHits.length > 0) {
  failures.push(
    `以下包是**非商用**许可，商用分发不能靠登记放行：${nonCommercialHits
      .map((entry) => `${entry.name}@${entry.versions.join('/') || '未知版本'}（${entry.license}）`)
      .join('、')}`,
  );
}

// 3.5 搬运层的许可全文随包核对（Apache-2.0/BSD 的义务在分发那一刻）。
const missingLicenseText = findVendoredPackagesMissingLicenseText(vendored);
const unregisteredMissing = missingLicenseText.filter((name) => MISSING_LICENSE_TEXT_DISPOSITIONS[name] === undefined);
if (unregisteredMissing.length > 0) {
  failures.push(`搬运层有包目录里没有许可全文、且没有处置登记：${unregisteredMissing.join(', ')}`);
}
const staleMissing = Object.keys(MISSING_LICENSE_TEXT_DISPOSITIONS).filter(
  (name) => !missingLicenseText.includes(name),
);
if (staleMissing.length > 0) {
  failures.push(
    `缺全文处置表里有 ${String(staleMissing.length)} 条已经没有对应的包（${staleMissing.join(', ')}），删掉以免误导`,
  );
}
// 记账文件要真的进产物：`extraResources` 里必须搬运汇总与记账文档两条。
const builderConfig = readFileSync(path.join(repoRoot, 'electron-builder.yml'), 'utf8');
const missingWiring = [THIRD_PARTY_NOTICES_FILE, 'LICENSES.md'].filter((name) => !builderConfig.includes(name));
if (missingWiring.length > 0) {
  failures.push(`electron-builder.yml 的 extraResources 没有把记账文件放进产物：${missingWiring.join(', ')}`);
}

// 4. 文档对齐。
const generated = renderGenerated(tableEntries, electron, missingLicenseText);
if (!existsSync(LICENSE_DOC)) {
  failures.push(`缺少 ${path.basename(LICENSE_DOC)}`);
} else {
  const doc = readFileSync(LICENSE_DOC, 'utf8');
  const start = doc.indexOf(BEGIN);
  const end = doc.indexOf(END);
  if (start < 0 || end < 0) {
    failures.push(`${path.basename(LICENSE_DOC)} 里没有生成节锚点，跑 --write 补上`);
  } else if (writeMode) {
    writeFileSync(LICENSE_DOC, `${doc.slice(0, start + BEGIN.length)}\n\n${generated}\n\n${doc.slice(end)}`, 'utf8');
    console.log(`✔ 已重写 ${path.basename(LICENSE_DOC)} 的生成节（${String(entries.length)} 个包条目）`);
  } else if (normalizeMarkdown(doc.slice(start + BEGIN.length, end)) !== normalizeMarkdown(generated)) {
    failures.push(
      `${path.basename(LICENSE_DOC)} 的生成节与当前扫描结果不一致，跑 tsx scripts/check-licenses.ts --write`,
    );
  }
}

// 随包运行时的产物侧核对（产物不存在时如实跳过）。
// 三端的产物目录形状不同，写死 win 一种会让 mac / linux 构建永远「没跑」：
// win 是 `dist/win-unpacked/`（arm64 出 `win-arm64-unpacked`），linux 是 `dist/linux-unpacked/`
// （**实测 arm64 出的是 `linux-arm64-unpacked`**，写死无后缀那个名字会让 linux 侧永远核对不到），
// mac 是 `dist/<mac 目录>/auto-cc.app/Contents/Resources/`
// ——实测 electron-builder 26 + electron 44.4.5 在 arm64 上出 `mac-arm64`，在 x64 上出 `mac`（构建日志 `appOutDir=dist/mac`）。
// 只核对**本机这一档 arch**：另一档留下的旧目录可能是补位之前打的，拿它判失败等于让 lint 依赖构建残留。
// mac 侧为什么要单独盯这两个文件：win/linux 的 unpacked 里 electron-builder 会自动放 electron 的许可全文，
// **mac 的 .app 布局它不放**，靠 `electron-builder.yml` 的 `mac.extraResources` 补位（§8.7 许可记账红线）。
const macOutDirs = process.arch === 'arm64' ? ['mac-arm64'] : ['mac', 'mac-x64'];
const unpackedDirs = [
  'win-unpacked',
  `win-${process.arch}-unpacked`,
  'linux-unpacked',
  `linux-${process.arch}-unpacked`,
];
const artifactRoots: { label: string; dir: string }[] = [
  ...unpackedDirs.map((dir) => ({ label: dir, dir: path.join(repoRoot, 'dist', dir) })),
  ...macOutDirs.map((dir) => ({
    label: dir,
    dir: path.join(repoRoot, 'dist', dir, 'auto-cc.app', 'Contents', 'Resources'),
  })),
];
const builtArtifacts = artifactRoots
  .filter((root) => existsSync(root.dir))
  .map((root) => ({
    ...root,
    missingLicenseFiles: ['LICENSE.electron.txt', 'LICENSES.chromium.html'].filter(
      (name) => !existsSync(path.join(root.dir, name)),
    ),
  }));
for (const artifact of builtArtifacts) {
  if (artifact.missingLicenseFiles.length > 0) {
    failures.push(
      `产物 ${artifact.label} 里缺少 electron 自带的许可文件：${artifact.missingLicenseFiles.join(', ')}（mac 侧由 electron-builder.yml 的 mac.extraResources 补位）`,
    );
  }
}

// 产物侧到底核没核过，要在失败输出里也看得见：5.10-15 的产物半边判据就是"本轮没跑"和"跑过且齐"
// 必须能被区分出来，否则 LICENSES.md 那一半一红，产物那一半的状态就跟着一起消失在输出里。
if (builtArtifacts.length === 0)
  console.log('  · 提示：dist/ 下没有任何一端产物，产物侧许可文件本轮未核对（不是通过，是没跑）');
else
  console.log(
    `  · 产物侧已核对：${builtArtifacts
      .map(
        (a) =>
          `${a.label}（${
            a.missingLicenseFiles.length === 0
              ? 'LICENSE.electron.txt + LICENSES.chromium.html 齐'
              : `缺 ${a.missingLicenseFiles.join(' / ')}`
          }）`,
      )
      .join('、')}`,
  );

if (failures.length > 0) {
  console.error('✖ 许可证记账检查未通过：');
  failures.forEach((line) => console.error(`  · ${line}`));
  process.exit(1);
}
{
  const groups = new Set(entries.map((entry) => entry.license)).size;
  console.log(
    `✔ 许可证记账检查通过（生产依赖 ${String(entries.length)} 个包条目 / 记账表 ${String(tableEntries.length)} 行` +
      `（其余 ${String(platformOnly.length)} 行是平台专属可选包，由父包代表）/ ${String(groups)} 种许可；` +
      `搬运层 ${String(vendored.length)} 个包全部在册，其中 ${String(missingLicenseText.length)} 个上游无许可全文、已登记处置；` +
      `copyleft 命中 ${String(hitNames.size)} 条且都有处置）`,
  );
}
