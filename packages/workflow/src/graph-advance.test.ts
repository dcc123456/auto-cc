/**
 * 图推进语义用例（spec 5.10-08 / 09 的 U 半边，plan §7.8.3 的 f 片）。
 *
 * 这里**不**起 cordis、不碰库：判据是「给定一张图和一段结算历史，谁此刻该跑、谁该被判跳过」，
 * 它是纯推导，所以能用单测穷举到分支、汇聚、级联三种形状（活体截图证不了「join 只执行一次」这一条，
 * 而 5.10-09 要的正是它）。runner 接线与截图证据是同一片的后半，落地时另记。
 */
import { describe, expect, it } from 'vitest';
import { advanceGraph, initialAdvanceState } from './graph-advance.js';
import { buildGraph } from './graph.js';
import type { WorkflowGraphView } from '@auto-cc/core';

/** 一个节点声明（`outputs` 省略即只有 `default` 出口，与 2.4 的线性计划同一种写法）。 */
type NodeSeed = { id: string; outputs?: string[] };

/**
 * 造一张只用于推进判定的图：kind/effect 全部取已登记的 `jd.capture` + read，
 * 因为这一层根本不看算子（看的是边），把无关字段固定成同一个值能让用例只暴露形状差异。
 * @param id 图 id
 * @param seeds 节点与其出口声明
 * @param edges 边（`handle` 省略即 `default`）
 * @returns 校验并算好指纹的图读数
 */
function graphOf(
  id: string,
  seeds: readonly NodeSeed[],
  edges: readonly { id: string; source: string; handle?: string; target: string }[],
): WorkflowGraphView {
  return buildGraph({
    id,
    nodes: seeds.map((seed) => ({
      id: seed.id,
      kind: 'jd.capture',
      effect: 'read',
      target: `https://fixture.example/${seed.id}`,
      ...(seed.outputs ? { outputs: seed.outputs } : {}),
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      ...(edge.handle ? { sourceHandle: edge.handle } : {}),
      target: edge.target,
    })),
  });
}

/** 按顺序推进一串结算（每笔都是 done，出口走 `default` 或指定值）。 */
function run(state: ReturnType<typeof initialAdvanceState>, graph: WorkflowGraphView, steps: string[]) {
  return steps.reduce((current, nodeId) => advanceGraph(current, graph, { nodeId, status: 'done' }), state);
}

describe('线性图（2.4 那三条计划的原样形状）', () => {
  const chain = graphOf('plan-advance-linear', [{ id: 'a' }, { id: 'b' }], [{ id: 'e-1', source: 'a', target: 'b' }]);

  it('起点是没有入边的那一个，不是 nodes[0]', () => {
    expect(initialAdvanceState(chain).ready).toEqual(['a']);
  });

  it('a 结束后只有 b 可跑，b 结束后整张图结算完', () => {
    const afterA = advanceGraph(initialAdvanceState(chain), chain, { nodeId: 'a', status: 'done' });
    expect(afterA.ready).toEqual(['b']);
    expect(afterA.finished).toBe(false);
    const afterB = advanceGraph(afterA, chain, { nodeId: 'b', status: 'done' });
    expect(afterB.ready).toEqual([]);
    expect(afterB.finished).toBe(true);
    // 线性推进下它与 `machine.ts` 的「下标 +1」给出同一个执行顺序——这就是 5.10-02 的投影判据能反向成立的底子。
    expect(Object.keys(afterB.outcomes)).toEqual(['a', 'b']);
  });
});

describe('条件分支（spec 5.10-08：未走的那支是 skipped，不是 pending）', () => {
  // 分支图：cond 有 yes / no 两个出口；no 支后面还挂着一个 downstream，跳过必须级联下去。
  const branching = graphOf(
    'plan-advance-branch',
    [{ id: 'cond', outputs: ['yes', 'no'] }, { id: 'yes-1' }, { id: 'no-1' }, { id: 'downstream' }],
    [
      { id: 'e-y', source: 'cond', handle: 'yes', target: 'yes-1' },
      { id: 'e-n', source: 'cond', handle: 'no', target: 'no-1' },
      { id: 'e-d', source: 'no-1', target: 'downstream' },
    ],
  );

  it('走 yes 时 no 支与它的下游一起判 skipped', () => {
    const afterCond = advanceGraph(initialAdvanceState(branching), branching, {
      nodeId: 'cond',
      status: 'done',
      output: 'yes',
    });
    expect(afterCond.ready).toEqual(['yes-1']);
    expect(afterCond.outcomes['no-1']?.status).toBe('skipped');
    expect(afterCond.outcomes['downstream']?.status).toBe('skipped');
    expect(afterCond.finished).toBe(false);
  });

  it('走 no 时 yes 支 skipped，且 no-1 与 downstream 依次可跑', () => {
    const afterCond = advanceGraph(initialAdvanceState(branching), branching, {
      nodeId: 'cond',
      status: 'done',
      output: 'no',
    });
    expect(afterCond.ready).toEqual(['no-1']);
    expect(afterCond.outcomes['yes-1']?.status).toBe('skipped');
    const afterNo = advanceGraph(afterCond, branching, { nodeId: 'no-1', status: 'done' });
    expect(afterNo.ready).toEqual(['downstream']);
    expect(run(afterNo, branching, ['downstream']).finished).toBe(true);
  });

  it('节点声明里没有那个出口时结构化拒绝，并点出能走的是哪些', () => {
    let caught: unknown;
    try {
      advanceGraph(initialAdvanceState(branching), branching, { nodeId: 'cond', status: 'done', output: 'maybe' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect((caught as Error).message).toMatch(/没有声明出口 maybe/);
  });
});

describe('并行扇出与汇聚（spec 5.10-09：入边全到齐才执行，且只执行一次）', () => {
  // 菱形：a 同时出两条边，两支都完成后 join 才可跑。
  const diamond = graphOf(
    'plan-advance-diamond',
    [{ id: 'a' }, { id: 'left' }, { id: 'right' }, { id: 'join' }],
    [
      { id: 'e-l', source: 'a', target: 'left' },
      { id: 'e-r', source: 'a', target: 'right' },
      { id: 'e-jl', source: 'left', target: 'join' },
      { id: 'e-jr', source: 'right', target: 'join' },
    ],
  );

  it('a 之后两支同时可跑（两条出边可同时推进）', () => {
    const afterA = advanceGraph(initialAdvanceState(diamond), diamond, { nodeId: 'a', status: 'done' });
    expect(afterA.ready).toEqual(['left', 'right']);
  });

  it('只有一支到齐时 join 继续等，另一支照旧可跑（并行不是串行）', () => {
    const afterLeft = run(initialAdvanceState(diamond), diamond, ['a', 'left']);
    // 兄弟支没被任何规则吞掉：它仍是待执行，只是 join 还不能开始。
    expect(afterLeft.ready).toEqual(['right']);
    expect(afterLeft.outcomes['join']).toBeUndefined();
    expect(afterLeft.finished).toBe(false);
  });

  it('两支都到齐后 join 可跑，且再推进也不会第二次进入 ready（执行一次）', () => {
    const afterBoth = run(initialAdvanceState(diamond), diamond, ['a', 'left', 'right']);
    expect(afterBoth.ready).toEqual(['join']);
    const afterJoin = advanceGraph(afterBoth, diamond, { nodeId: 'join', status: 'done' });
    expect(afterJoin.ready).not.toContain('join');
    expect(afterJoin.finished).toBe(true);
    // 汇聚点确实只结算了一次：读数里它只有一条记录，状态就是 done。
    expect(afterJoin.outcomes['join']).toEqual({ status: 'done', output: 'default' });
  });

  it('整支被跳过时汇聚点也 skipped（不会永远挂在等待里）', () => {
    const branched = graphOf(
      'plan-advance-skip-join',
      [{ id: 'cond', outputs: ['yes', 'no'] }, { id: 'left' }, { id: 'right' }, { id: 'join' }],
      [
        { id: 'e-y', source: 'cond', handle: 'yes', target: 'left' },
        { id: 'e-n', source: 'cond', handle: 'no', target: 'right' },
        { id: 'e-jl', source: 'left', target: 'join' },
        { id: 'e-jr', source: 'right', target: 'join' },
      ],
    );
    const afterCond = advanceGraph(initialAdvanceState(branched), branched, {
      nodeId: 'cond',
      status: 'done',
      output: 'yes',
    });
    expect(afterCond.outcomes['right']?.status).toBe('skipped');
    const afterLeft = advanceGraph(afterCond, branched, { nodeId: 'left', status: 'done' });
    // left 活着、right 是 skipped：join 的入边全部结算且只有一条活边 → 照跑一次。
    expect(afterLeft.ready).toEqual(['join']);
    expect(afterLeft.outcomes['join']).toBeUndefined();
  });

  it('节点不在这张图里时结构化拒绝（续跑时图被改过就是这种读数）', () => {
    let caught: unknown;
    try {
      advanceGraph(initialAdvanceState(diamond), diamond, { nodeId: 'ghost', status: 'done' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'INVALID_ARGUMENT', path: 'workflow.advance' });
    expect((caught as Error).message).toMatch(/不在这张图里/);
  });
});
