/**
 * 通用快照式历史栈（spec 3.5-08 要的"既有历史机制"，plan §7.7「历史栈」那一行的落点）。
 *
 * 为什么要抽：这一份 past/present/future 最早长在 `graph-edit.ts`（5.10-19 已验收），
 * 编辑轨的轻编辑会话是它的第二个消费者——同一逻辑出现第二次就必须抽（AGENTS.md §2.2），
 * 而 3.5-08 的判据原文还额外要求"不引入第二套历史栈"，所以在这里收口成一只。
 *
 * 两条取舍沿用 5.10-19 当初的理由，不在这里重开：
 * - **存快照而不是存逆操作**：逆操作要为每类编辑各写一份反向逻辑，那是同一件事的第二套实现，
 *   漂了就变成"撤销一次得到一份哪都没见过的状态"（§2.6/§2.7）。
 * - **新编辑一律作废"重做"分支**：这不是协同编辑，没有两条历史线要留（plan §5.10.8 的"明确不做多人协同"）。
 *
 * 域内的"这一次编辑到底改没改"判断**留在调用方**（画布在那里查重名、比参数），
 * 这里只管推进历史——把语义判断下沉进来就得为每种状态写比较逻辑，又变成第二套。
 */

/** 历史栈的默认深度：一屏一屏地撤销几十次是人的极限，再深只是内存占用（§2.6 不做未来抽象）。 */
export const DEFAULT_SNAPSHOT_HISTORY = 50;

/**
 * 快照栈的读数（界面用它置灰撤销/重做按钮）。
 * @template T 被回退的状态，形状由调用方决定；本模块不认识它。
 */
export interface SnapshotStack<T> {
  /** 当前状态（**副本**：调用方改不动栈里的状态）。 */
  present(): T;
  /** 还能往回退几步。 */
  canUndo(): boolean;
  /** 还能往前重做几步。 */
  canRedo(): boolean;
  /**
   * 换上一份新状态并把它记为一步历史。
   *
   * 只在**真的改过**时调用：拿一次空编辑来 commit 会长出一条什么都没退到的撤销单元，
   * 判据里的"逐步回退"就此变成"按了没反应"。
   * @param next 新状态（立刻被 `clone` 一份，调用方之后改自己手里那份不影响栈）
   */
  commit(next: T): void;
  /**
   * 回退一步。
   * @returns 退成功返回 true；栈空时 false 且当前状态不变
   */
  undo(): boolean;
  /**
   * 重做一步（只在退回去之后又没做新编辑时可用）。
   * @returns 成功返回 true；没有可重做的步骤时 false
   */
  redo(): boolean;
}

/**
 * 建一只快照栈。
 * @param initial 初始状态（立刻被 `clone` 一份进去，调用方之后改原对象不影响栈）
 * @param clone 深拷函数——栈的"存快照"取舍要求状态之间引用无关，所以怎么拷只有调用方知道
 * @param historyCeiling 最多留几步历史，超出丢最老的（默认 {@link DEFAULT_SNAPSHOT_HISTORY}）
 * @returns 历史栈读数
 */
export function createSnapshotStack<T>(
  initial: T,
  clone: (state: T) => T,
  historyCeiling: number = DEFAULT_SNAPSHOT_HISTORY,
): SnapshotStack<T> {
  let present = clone(initial);
  const past: T[] = [];
  let future: T[] = [];

  return {
    present() {
      return clone(present);
    },
    canUndo() {
      return past.length > 0;
    },
    canRedo() {
      return future.length > 0;
    },
    commit(next) {
      past.push(present);
      if (past.length > historyCeiling) past.shift();
      // 进栈的一律是拷：调用方手里那份之后怎么改都影响不到历史，"撤销得到的就是当时提交的那份"才成立。
      present = clone(next);
      future = [];
    },
    undo() {
      const previous = past.pop();
      if (previous === undefined) return false;
      future.push(present);
      present = previous;
      return true;
    },
    redo() {
      const next = future.pop();
      if (next === undefined) return false;
      past.push(present);
      present = next;
      return true;
    },
  };
}
