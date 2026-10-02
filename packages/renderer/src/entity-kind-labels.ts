import type { KbEntityKindView } from '@auto-cc/shared';

/**
 * 库内实体种类 → 文案键（`kb.kind*` 那批既有译文）。
 *
 * 抽出来是因为知识库面板（"库里有什么"）与缺口面板（"这份 JD 要我有什么"的亮点栏）
 * 画的是同一套四种实体，同一段映射出现第二次就必须抽公共层（AGENTS.md §2.2）；
 * 键仍指 `kb.kind*` 而不是新起一组 `gap.*`，是为了两处界面对同一种实体说同一句话（§2.5）。
 */
export const ENTITY_KIND_LABEL_KEY: Record<KbEntityKindView, string> = {
  experience: 'kb.kindExperience',
  project: 'kb.kindProject',
  skill: 'kb.kindSkill',
  achievement: 'kb.kindAchievement',
};
