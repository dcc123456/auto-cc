/**
 * 通用快照栈的机制用例（spec 3.5-08 的"基于既有历史机制"这一半 / plan §7.7「历史栈」）。
 *
 * 这里只测**与状态形状无关**的那几条：初始拷贝、读数给副本、commit 推进、重做分支作废、深度上限、空栈行为。
 * "三类编辑各产生一条撤销单元"那类判据不在这里——它属画布那一层的语义，
 * 已由 `packages/workflow/src/graph-edit.test.ts`（5.10-19 已验收）逐条钉住，抽取之后仍由它守门。
 */
import { describe, expect, it } from 'vitest';
import { createSnapshotStack, DEFAULT_SNAPSHOT_HISTORY } from './snapshot-stack.js';

/** 一个够用的状态形状：只有一串标签，栈不该关心它是什么。 */
type TagState = { tags: string[] };

/** 深拷一份状态（栈对外承诺状态之间引用无关，测试自己也要有同一份口径）。 */
function cloneState(state: TagState): TagState {
  return { tags: [...state.tags] };
}

/**
 * 造一只栈并顺手建一个"追加一个标签"的提交口，免得每条用例重写一遍展开。
 * @param initial 初始状态
 * @param historyCeiling 历史深度上限
 * @returns 栈读数与 `push(tag)`（返回 true 表示这一步真的产生了历史）
 */
function stackOf(initial: TagState, historyCeiling: number = DEFAULT_SNAPSHOT_HISTORY) {
  const stack = createSnapshotStack(initial, cloneState, historyCeiling);
  /**
   * 追加一个标签并提交（写成箭头常量而不是方法简写：解构一个方法会脱开 `this`，eslint 的 unbound-method 直接拦）。
   * @param tag 新标签
   */
  const push = (tag: string): void => {
    stack.commit({ tags: [...stack.present().tags, tag] });
  };
  return { stack, push };
}

describe('快照栈（spec 3.5-08 要的那一只历史栈）', () => {
  it('构造即拷：之后改调用方手里那份初始对象，栈里的状态不动', () => {
    const source: TagState = { tags: ['a'] };
    const { stack } = stackOf(source);
    source.tags.push('sneaky');
    expect(stack.present()).toEqual({ tags: ['a'] });
  });

  it('读数给副本：改拿到的数组写不穿栈', () => {
    const { stack, push } = stackOf({ tags: ['a'] });
    push('b');
    const leaked = stack.present();
    leaked.tags.push('c');
    expect(stack.present().tags).toEqual(['a', 'b']);
  });

  it('连续五步撤销到底再重做到底，两端状态与逐步读数一致（3.5-08 的判据形状）', () => {
    const start: TagState = { tags: ['a'] };
    const { stack, push } = stackOf(start);
    for (const tag of ['b', 'c', 'd', 'e', 'f']) push(tag);
    expect(stack.present().tags).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);

    const afterEachUndo: string[][] = [];
    for (let step = 0; step < 5; step += 1) {
      expect(stack.undo()).toBe(true);
      afterEachUndo.push(stack.present().tags);
    }
    expect(afterEachUndo.map((tags) => tags.length)).toEqual([5, 4, 3, 2, 1]);
    expect(stack.present()).toEqual(start);
    expect(stack.canUndo()).toBe(false);

    for (let step = 0; step < 5; step += 1) {
      expect(stack.redo()).toBe(true);
    }
    expect(stack.present().tags).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(stack.canRedo()).toBe(false);
  });

  it('撤销之后再做新编辑即作废重做分支（不留两条历史线）', () => {
    const { stack, push } = stackOf({ tags: ['a'] });
    push('b');
    push('c');
    stack.undo();
    expect(stack.canRedo()).toBe(true);
    push('d');
    expect(stack.canRedo()).toBe(false);
    expect(stack.present().tags).toEqual(['a', 'b', 'd']);
  });

  it('超出深度上限丢最老的一步，而不是无限涨', () => {
    const { stack, push } = stackOf({ tags: ['a'] }, 3);
    for (const tag of ['b', 'c', 'd', 'e']) push(tag);
    let steps = 0;
    while (stack.undo()) steps += 1;
    expect(steps).toBe(3);
    expect(stack.present().tags).toEqual(['a', 'b']);
  });

  it('空栈上 undo/redo 都返回 false 且当前状态不变（界面据此置灰，不是抛异常）', () => {
    const { stack } = stackOf({ tags: ['a'] });
    expect(stack.undo()).toBe(false);
    expect(stack.redo()).toBe(false);
    expect(stack.present().tags).toEqual(['a']);
  });

  it('提交进栈的是拷贝：调用方之后再改手里那份，历史与当前状态都不动', () => {
    const { stack } = stackOf({ tags: ['a'] });
    const next: TagState = { tags: ['a', 'b'] };
    stack.commit(next);
    next.tags.push('mutated-after-commit');
    expect(stack.present().tags).toEqual(['a', 'b']);
    expect(stack.undo()).toBe(true);
    expect(stack.present().tags).toEqual(['a']);
  });
});
