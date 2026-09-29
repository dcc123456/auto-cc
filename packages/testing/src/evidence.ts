/**
 * 验收证据归档（spec 1.6-11）。
 *
 * 过程截图写在临时目录里，只有显式归档才搬进 `docs/acceptance/<子计划>/`，并且必须叫
 * `<spec-id>-<slug>.png` —— 这个名字格式不是洁癖，而是 `.githooks/pre-commit` 的放行条件
 * （AGENTS.md §7.5：过程图不得进库）。把规则放进代码，脚本就写不出会被钩子拒掉的证据。
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';

/** 与 pre-commit 钩子同源的 spec 条目号形状，例如 `1.6-02`、`1.10-11a`。 */
export const SPEC_ID_PATTERN = /^\d+\.\d+-\d+[a-z]?$/;

/** 允许归档的证据类型：图片 + 机读文本，不让人把无关文件塞进验收目录。 */
const EVIDENCE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.txt', '.json'];

export type ArchivedFile = { source: string; target: string; isFresh: boolean };

/**
 * 推出证据的目标文件名。
 * @param specId 形如 `1.6-02` 的条目号
 * @param source 源文件路径
 * @param slug 可选的语义后缀；缺省时取源文件名
 * @returns `<spec-id>-<slug><ext>`
 */
export function evidenceName(specId: string, source: string, slug?: string): string {
  if (!SPEC_ID_PATTERN.test(specId)) throw new Error(`spec 条目号不合法：${specId}（应形如 1.6-02）`);
  const extension = path.extname(source).toLowerCase();
  if (!EVIDENCE_EXTENSIONS.includes(extension)) {
    throw new Error(`证据类型不支持：${extension || '(无扩展名)'}，可用 ${EVIDENCE_EXTENSIONS.join(' / ')}`);
  }
  const base = path.basename(source, path.extname(source));
  // 已经按条目号命名过的文件保持原名，重复归档才不会造出 `1.6-02-1.6-02-xxx` 这种套娃名。
  const raw = base.startsWith(`${specId}-`) ? base.slice(specId.length + 1) : (slug ?? base);
  const safe = raw.replace(/[\s_]+/g, '-');
  // 钩子按 `[0-9][0-9.]*-[0-9]+[a-z]?[A-Za-z0-9._-]*` 放行图片，中文后缀会被拒在提交门外，
  // 所以这里直接要求 ASCII，而不是等提交时才发现证据进不了库。
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(safe)) {
    throw new Error(`证据后缀必须是 ASCII（字母/数字/._-，空格转连字符）：${raw}`);
  }
  return `${specId}-${safe}${extension}`;
}

/**
 * 把证据搬进 `docs/acceptance/<子计划>/`。
 * @param repoRoot 仓库根（决定 `docs/acceptance` 落点）
 * @param specId 条目号，其前缀（如 `1.6`）即子计划目录名
 * @param sources 待归档的源文件路径列表
 * @param slug 可选语义后缀
 * @returns 目标目录与每个文件的归档结果
 */
export function archiveEvidence(
  repoRoot: string,
  specId: string,
  sources: string[],
  slug?: string,
): {
  dir: string;
  files: ArchivedFile[];
} {
  const subPlan = specId.split('-')[0] as string;
  const dir = path.join(repoRoot, 'docs', 'acceptance', subPlan);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return {
    dir,
    files: sources.map((source) => {
      const resolved = path.resolve(source);
      if (!existsSync(resolved)) throw new Error(`证据文件不存在：${source}`);
      if (statSync(resolved).isDirectory()) throw new Error(`证据必须是文件，不接受目录：${source}`);
      const target = path.join(dir, evidenceName(specId, resolved, slug));
      // 钩子按路径族放行，所以目标越出 `docs/acceptance` 之前必须先挡掉，而不是等提交时才发现。
      if (!target.startsWith(path.join(repoRoot, 'docs', 'acceptance') + path.sep)) {
        throw new Error(`归档目标越出证据目录：${target}`);
      }
      const isFresh = path.resolve(target) !== resolved;
      if (isFresh) copyFileSync(resolved, target);
      return { source: resolved, target, isFresh };
    }),
  };
}
