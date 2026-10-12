/**
 * 必备信息清单的界面侧公共件（判定本体在主进程 `skill.ts`，这里只负责"怎么把结论画出来"）。
 *
 * 抽出来是因为两个面板都要读同一份清单（`SkillPanel` 逐行、`GeneratePanel` 一行汇总）：
 * 语气档与计数各写一份就是同一逻辑的第二次复制（AGENTS.md §2.2）。
 */
import type { RequiredInfoRowView, RequiredInfoStatusView } from '@auto-cc/shared';
import type { BannerTone } from './ui/controls';

/** 判定结局 → 语气档：`weak`（在，但不合格）与 `missing`（根本没有）的下一步不同，所以不同色。 */
export const REQUIRED_STATUS_TONE: Record<RequiredInfoStatusView, BannerTone> = {
  present: 'jade',
  weak: 'amber',
  missing: 'seal',
};

/** 判定结局 → 文案键（三句各说一句，不合成"还行"这类把两档并成一档的话）。 */
export const REQUIRED_STATUS_LABEL_KEY: Record<RequiredInfoStatusView, string> = {
  present: 'resume.skill.statusPresent',
  weak: 'resume.skill.statusWeak',
  missing: 'resume.skill.statusMissing',
};

/**
 * 数出「齐了几项」：只数 `present`，`weak` 算不合格（在但不合格，说成齐了就是谎报）。
 * @param rows 主进程给的逐项读数（界面不改判、不重排，只汇总已经判完的结论）
 * @returns `[齐的项数, 总项数]`，一次遍历拿两个数，界面因此不必再 `filter().length` 两遍
 */
export function countRequired(rows: readonly RequiredInfoRowView[]): readonly [number, number] {
  let present = 0;
  for (const row of rows) if (row.status === 'present') present += 1;
  return [present, rows.length];
}
