/**
 * 排版编辑会话（plan §8.3 的 `editor-session.ts`，接住 spec 3.6-03 的「撤销/重做与状态面板反映当前步骤」）。
 *
 * 装的是那份**正在编辑的简历文档**：四个动作（区块重排、条目重排、改度量、改样式）都只在真的改了它的时候
 * 长出一条撤销单元。历史机制一律走 `@auto-cc/core` 的 `createSnapshotStack`——全仓唯一那一份
 * past/present/future（画布 5.10-19 与轻编辑 3.5-08 是两个已验收消费者），这里开第三份栈就是违反
 * 3.5-08 那句"不引入第二套历史栈"（AGENTS.md §2.2）。
 *
 * 为什么「空编辑不进栈」用 `contentHash` 而不是逐动作写三份相等判断：`normalize.ts` 那份 canonical
 * 已经定义了"两份文档内容上是不是同一份"（`updatedAt` 不参与，见 `model.ts:110`），
 * 再为每种动作各写一遍比较逻辑就是同一件事的第二套实现（§2.5），而且迟早和 hash 口径分叉。
 *
 * 模板与语言**不进历史**（plan §8.1 第 2 条）：它们是渲染期的视图旋钮，文档模型里没有 templateId，
 * 一次切换不改一个字节，于是 3.6-04 的"切换即时生效且不丢数据"在这里是**结构上不可能失败**的——
 * 退回去也退不掉它，撤销列表里也不会凭空多出一条"什么都没变"的步骤。
 */
import { createSnapshotStack, DEFAULT_SNAPSHOT_HISTORY } from '@auto-cc/core/snapshot-stack';
import type { ResumeDocument } from './model.js';
import { contentHash } from './normalize.js';
import type { TemplateLocale } from './template.js';
import {
  planEntryMove,
  planMetric,
  planDesign,
  planSectionMove,
  type DesignPatch,
  type EditorOutcome,
  type MetricKey,
} from './editor-ops.js';

/** 建会话时需要的读数。 */
export interface ResumeEditorSessionOptions {
  /** 打开编辑器时选中的模板 id（由服务层给出，会话不去查注册表——查它是 `resume.doc` 那条线的事） */
  readonly templateId: string;
  /** 预览语言，默认 `zh-CN`（与 `resume.export.preview` 的默认值同一口径） */
  readonly locale?: TemplateLocale;
  /** 历史深度，超出丢最老的（默认与画布、轻编辑那两处同值，三处不该长出不一样的步数） */
  readonly historyCeiling?: number;
}

/** 会话的读数与动作。 */
export interface ResumeEditorSession {
  /** 正在编辑的那份文档（**副本**：调用方改动手里那份动不到栈里）。 */
  document(): ResumeDocument;
  /**
   * 有没有改过（3.6-09 那句"未保存离开有拦截提示"的读数）。
   * @returns 与打开时内容一致返回 false；注意**撤销回原样就不再是 dirty**，这正是内容 hash 判据的用处
   */
  isDirty(): boolean;
  templateId(): string;
  locale(): TemplateLocale;
  /**
   * 换预览/导出用的模板，**不碰文档**、不产生撤销单元。
   * @param id 目标模板 id（存在与否由服务层按注册表判，会话只记这个字符串）
   */
  useTemplate(id: string): void;
  /**
   * 换预览/导出用的语言，同样不碰文档。
   * @param value 目标语言
   */
  useLocale(value: TemplateLocale): void;
  canUndo(): boolean;
  canRedo(): boolean;
  /**
   * 区块重排（spec 3.6-01）。
   * @param sectionId 被拖的区块 id
   * @param toIndex 落点下标（结果序列里的位置）
   * @returns 通过给**动作之后**的文档：真的改了什么就是新文档，拖回原地则是当前文档（不另入栈）；
   *          id 查无、下标越界则给 `editor-ops` 那份拒绝项（原样转发，不在这里造第二种失败形状）
   */
  moveSection(sectionId: string, toIndex: number): EditorOutcome<ResumeDocument>;
  /**
   * 条目重排，作用域限在其所属区块内。
   * @param sectionId 条目所属区块 id
   * @param entryId 被拖的条目 id
   * @param toIndex 该区块内的目标下标
   * @returns 同 `moveSection`
   */
  moveEntry(sectionId: string, entryId: string, toIndex: number): EditorOutcome<ResumeDocument>;
  /**
   * 改一条度量（spec 3.6-02）。
   * @param key 度量键（`baseFontPt` / `lineHeight` / 边距四条之一）
   * @param value 新值（单位随键；界外与非有限数都拒）
   * @returns 同 `moveSection`；界外给 `out-of-bounds`，非有限数给 `not-a-number`
   */
  setMetric(key: MetricKey, value: number): EditorOutcome<ResumeDocument>;
  /**
   * 改主题/段落样式（spec 6.6-05）。一次调用是一个撤销单元：弹窗里"整格保存"就是这一条。
   * @param patch 结构化补丁（见 `editor-ops.ts` 的 `DesignPatch`；给 `null` 是清掉那一格）
   * @returns 同 `moveSection`；形状非法给 `editor-ops` 的拒绝项（原样转发，不在这里判第二遍）
   */
  setDesign(patch: DesignPatch): EditorOutcome<ResumeDocument>;
  /** 回退一步；栈空返回 false 且文档不变。 */
  undo(): boolean;
  /** 重做一步；没有可重做的返回 false。 */
  redo(): boolean;
  /**
   * 把"打开时那份"重新基线化成当前内容——**保存成功之后**调它。
   * 不调的话刚存完的 draft 仍与旧基线不同，`isDirty()` 会一直返回 true，
   * 于是 3.6-09 的未保存拦截会在用户刚刚保存之后又拦一次（撤销历史照旧保留，退得回去）。
   */
  markSaved(): void;
}

/**
 * 建一只编辑会话。
 * @param initial 打开时那份已保存的文档（立刻被拷进去；服务层给的一定是过 `validateDocument` 的合法文档，
 *                所以这里**不再校验**——校验只有一个入口，就是保存时那一份，§2.5）
 * @param options 模板、语言、历史深度
 * @returns 会话读数
 */
export function createResumeEditorSession(
  initial: ResumeDocument,
  options: ResumeEditorSessionOptions,
): ResumeEditorSession {
  const stack = createSnapshotStack(initial, structuredClone, options.historyCeiling ?? DEFAULT_SNAPSHOT_HISTORY);
  let openedHash = contentHash(initial);
  let templateId = options.templateId;
  let locale: TemplateLocale = options.locale ?? 'zh-CN';

  /**
   * 候选文档真的改了才进栈。
   * @param next 动作产出的新文档
   * @returns 通过给"现在就是 present"的那一份：真的推进了历史是新文档，内容与现值相同（空编辑）则是原样
   */
  const apply = (next: ResumeDocument): EditorOutcome<ResumeDocument> => {
    if (contentHash(next) === contentHash(stack.present())) return { ok: true, value: stack.present() };
    stack.commit(next);
    return { ok: true, value: next };
  };

  return {
    document() {
      return stack.present();
    },
    isDirty() {
      return contentHash(stack.present()) !== openedHash;
    },
    templateId() {
      return templateId;
    },
    locale() {
      return locale;
    },
    useTemplate(id) {
      templateId = id;
    },
    useLocale(value) {
      locale = value;
    },
    canUndo() {
      return stack.canUndo();
    },
    canRedo() {
      return stack.canRedo();
    },
    moveSection(sectionId, toIndex) {
      const current = stack.present();
      const moved = planSectionMove(current.sections, sectionId, toIndex);
      // 拒绝腿原样转发：判据只有一份（`editor-ops`），会话不造第二种失败形状。
      if (!moved.ok) return moved;
      return apply({ ...current, sections: moved.value });
    },
    moveEntry(sectionId, entryId, toIndex) {
      const current = stack.present();
      const moved = planEntryMove(current.sections, sectionId, entryId, toIndex);
      if (!moved.ok) return moved;
      return apply({ ...current, sections: moved.value });
    },
    setMetric(key, value) {
      const current = stack.present();
      const planned = planMetric(current.layout, key, value);
      if (!planned.ok) return planned;
      return apply({ ...current, layout: planned.value });
    },
    setDesign(patch) {
      const current = stack.present();
      const planned = planDesign(current.layout, patch);
      // 判据只有一份：颜色/档位/界外都由 `planDesign` 挡，会话不写第二条 if（AGENTS.md §2.5）。
      if (!planned.ok) return planned;
      return apply({ ...current, layout: planned.value });
    },
    undo() {
      return stack.undo();
    },
    redo() {
      return stack.redo();
    },
    markSaved() {
      openedHash = contentHash(stack.present());
    },
  };
}
