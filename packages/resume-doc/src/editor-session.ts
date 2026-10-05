/**
 * 排版编辑会话（plan §8.3 的 `editor-session.ts`，接住 spec 3.6-03 的「撤销/重做与状态面板反映当前步骤」）。
 *
 * 装的是那份**正在编辑的简历文档**：三个动作（区块重排、条目重排、改度量）都只在真的改了它的时候
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
import { planEntryMove, planMetric, planSectionMove, type MetricKey } from './editor-ops.js';

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
   * @returns 真的推进了一步才 true；id 查无、下标越界、拖回原地都返回 false 且不入栈
   */
  moveSection(sectionId: string, toIndex: number): boolean;
  /**
   * 条目重排，作用域限在其所属区块内。
   * @param sectionId 条目所属区块 id
   * @param entryId 被拖的条目 id
   * @param toIndex 该区块内的目标下标
   * @returns 同 `moveSection`
   */
  moveEntry(sectionId: string, entryId: string, toIndex: number): boolean;
  /**
   * 改一条度量（spec 3.6-02）。
   * @param key 度量键（`baseFontPt` / `lineHeight` / 边距四条之一）
   * @param value 新值（单位随键；界外与非有限数都拒）
   * @returns 真的推进了一步才 true；界外与"就是现值"都返回 false
   */
  setMetric(key: MetricKey, value: number): boolean;
  /** 回退一步；栈空返回 false 且文档不变。 */
  undo(): boolean;
  /** 重做一步；没有可重做的返回 false。 */
  redo(): boolean;
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
  const openedHash = contentHash(initial);
  let templateId = options.templateId;
  let locale: TemplateLocale = options.locale ?? 'zh-CN';

  /**
   * 候选文档真的改了才进栈。
   * @param next 动作产出的新文档
   * @returns 推进了历史才 true
   */
  const commit = (next: ResumeDocument): boolean => {
    if (contentHash(next) === contentHash(stack.present())) return false;
    stack.commit(next);
    return true;
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
      // 拒绝腿不动栈，也不报错：界面读的是 `planSectionMove` 的 code（会话只回答"进没进一步"）。
      if (!moved.ok) return false;
      return commit({ ...current, sections: moved.value });
    },
    moveEntry(sectionId, entryId, toIndex) {
      const current = stack.present();
      const moved = planEntryMove(current.sections, sectionId, entryId, toIndex);
      if (!moved.ok) return false;
      return commit({ ...current, sections: moved.value });
    },
    setMetric(key, value) {
      const current = stack.present();
      const planned = planMetric(current.layout, key, value);
      if (!planned.ok) return false;
      return commit({ ...current, layout: planned.value });
    },
    undo() {
      return stack.undo();
    },
    redo() {
      return stack.redo();
    },
  };
}
