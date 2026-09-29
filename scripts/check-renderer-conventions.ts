/**
 * 渲染层规范机检（AGENTS.md §5.1/§5.3/§5.5/§5.6，spec 1.2-13…1.2-16）。
 *
 * eslint 负责逐文件拦截（内联 style、自制 svg、裸中文、非入口样式），
 * 这个脚本负责跨文件一致性的四类事实：样式文件白名单、语言包 key 对齐、
 * 代码里用到的 i18n key 是否真的存在、内核视图宽度两侧是否同源。
 * 任一不符即 exit 1，因此挂在 `pnpm lint` 上是硬门禁而不是提示。
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const rendererRoot = path.join(repoRoot, 'packages', 'renderer', 'src');
const localesDir = path.join(rendererRoot, 'locales');
const allowedCss = ['globals.css'];

const failures: string[] = [];

/** 把嵌套 JSON 展平成 `a.b.c` 形式的 key 列表。 */
function flatten(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return prefix ? [prefix] : [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flatten(child, prefix ? `${prefix}.${key}` : key),
  );
}

async function files(dir: string, matcher: (name: string) => boolean): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await files(full, matcher)));
    else if (matcher(entry.name)) found.push(full);
  }
  return found;
}

// 1) 样式文件只允许入口 globals.css（1.2-13）
const cssFiles = await files(rendererRoot, (name) => name.endsWith('.css'));
for (const file of cssFiles) {
  if (!allowedCss.includes(path.basename(file))) {
    failures.push(`样式文件只允许入口 globals.css，发现 ${path.relative(repoRoot, file)}`);
  }
}

// 2) 语言包 key 必须完全对齐，缺失即失败（1.2-16）；以 zh-CN 为基准，报错才指得清是谁缺。
const localeNames = (await readdir(localesDir)).filter((name) => name.endsWith('.json')).sort();
const localeKeys = new Map<string, string[]>();
for (const name of localeNames) {
  const json = JSON.parse(await readFile(path.join(localesDir, name), 'utf8')) as unknown;
  localeKeys.set(name, flatten(json).sort());
}
const reference = localeNames.includes('zh-CN.json') ? 'zh-CN.json' : localeNames[0];
if (!reference) failures.push('locales 目录下一个语言包都没有');
for (const name of localeNames) {
  if (!reference || name === reference) continue;
  const expected = new Set(localeKeys.get(reference));
  const actual = new Set(localeKeys.get(name) ?? []);
  const missing = [...expected].filter((key) => !actual.has(key));
  const extra = [...actual].filter((key) => !expected.has(key));
  if (missing.length) failures.push(`${name} 缺少 key：${missing.join(', ')}`);
  if (extra.length) failures.push(`${name} 多出 key：${extra.join(', ')}`);
}

// 3) 代码里引用的 i18n key 必须在语言包里存在（防拼写漂移）
//    i18next 的 `t('title')` 在 defaultNS 下解析为 `shell.title`，因此允许两种写法。
const zhKeys = new Set(localeKeys.get('zh-CN.json') ?? []);
const resolvableKeys = new Set<string>(zhKeys);
for (const key of zhKeys) {
  const [, ...rest] = key.split('.');
  if (rest.length) resolvableKeys.add(rest.join('.'));
}
const tsxFiles = await files(rendererRoot, (name) => /\.(tsx|ts)$/.test(name));
for (const file of tsxFiles) {
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(/\bt\(\s*'([^']+)'/g)) {
    const key = match[1];
    if (key && !resolvableKeys.has(key)) {
      failures.push(`${path.relative(repoRoot, file)} 引用了不存在的 i18n key：${key}`);
    }
  }
}

// 4) 内核视图宽度两侧同源（1.2-12）
const bridgeSource = await readFile(path.join(repoRoot, 'packages', 'shared', 'src', 'bridge.ts'), 'utf8');
const cssSource = await readFile(path.join(rendererRoot, 'globals.css'), 'utf8');
const ratio = Number(/KERNEL_VIEW_WIDTH_RATIO\s*=\s*([\d.]+)/.exec(bridgeSource)?.[1]);
const cssPercent = Number(/--kernel-view-width:\s*([\d.]+)%/.exec(cssSource)?.[1]);
if (!Number.isFinite(ratio) || !Number.isFinite(cssPercent)) {
  failures.push('无法解析内核视图宽度：KERNEL_VIEW_WIDTH_RATIO 或 --kernel-view-width 缺失');
} else if (Math.abs(ratio * 100 - cssPercent) > 0.001) {
  failures.push(`内核视图宽度不一致：主进程 ${String(ratio * 100)}% ≠ 渲染层 ${String(cssPercent)}%`);
}

if (failures.length) {
  console.error('✖ 渲染层规范检查未通过：');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`✔ 渲染层规范检查通过（${String(localeNames.length)} 个语言包，${String(tsxFiles.length)} 个源文件）`);
