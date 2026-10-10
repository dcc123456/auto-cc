/**
 * 编辑会话（3.5-c₂）的单测：判据是 spec 3.5-08 的「连续 5 步 undo/redo 状态一致」，
 * 外加四条"空编辑不许长出撤销单元"的语义腿——那类缺陷的表现为按一次撤销却什么都没退，
 * 用户会以为自己按错了键，而栈里其实多了一条一模一样的快照。
 *
 * 三条口径与已验收的 3.5-b / 3.5-c₁ 一致：
 * - 覆盖区合法性**只有一个判据**（`planOverlays`，与另存同一个），所以这里演"会话拦住中文"那一腿
 *   用的就是服务侧同一份尺度，而不是在会话里另写规则；
 * - 页序同理走 `planPageOrder`；
 * - 夹具用二进制精确的比例（0.25 / 0.5 / 0.125），免得断言在测浮点而不是测语义。
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createPdfEditSession, type PdfEditDraft, type PdfEditSession } from './edit-session.js';
import type { PdfPageMetric } from './pdf-document.js';
import type { PdfOverlayInput, PdfOverlayRect } from './overlay-writer.js';

/** 三页 A4 的量得（`pdf.io.open` 的回执形状，会话只吃这个读数，不重新装载文件）。 */
const pageMetrics: readonly PdfPageMetric[] = [1, 2, 3].map((number) => ({ number, widthPt: 595, heightPt: 842 }));

/** 会话尺度：`maxOverlays` 挑成 3，好演"加到第 4 区就被同一份判据拦住"那一腿。 */
const limits = { maxOverlays: 3, defaultTextSizePt: 11, minAreaRatio: 0.0001, maxPages: 10 };

/** 挪到新位置用的那份矩形（面积 0.03 远大于 `minAreaRatio`，边界也在页内）。 */
const movedRect: PdfOverlayRect = { xRatio: 0.1, yRatio: 0.2, widthRatio: 0.3, heightRatio: 0.1 };

/**
 * 一个盖在页面上半部的覆盖区。
 * @param id 标识
 * @param overrides 想改的字段（演中文、别的页号时就改这里）
 * @returns 覆盖区输入
 */
function box(id: string, overrides: Partial<PdfOverlayInput> = {}): PdfOverlayInput {
  return {
    id,
    pageNumber: 1,
    rect: { xRatio: 0.25, yRatio: 0.25, widthRatio: 0.5, heightRatio: 0.125 },
    ...overrides,
  };
}

/**
 * 起一只会话。
 * @param initial 初始 draft（默认：没有覆盖区、页序就是 `1…3`）
 * @returns 会话
 */
function boot(initial: Partial<PdfEditDraft> = {}): PdfEditSession {
  return createPdfEditSession(
    { overlays: initial.overlays ?? [], pageOrder: initial.pageOrder ?? [1, 2, 3] },
    { pageMetrics, limits },
  );
}

describe('3.5-08 的判据原文：连续 5 步编辑，逐层退回底、再逐层重做到顶', () => {
  it('每一步的历史都逐层对得上：退到底就是初始那份，重做到顶就是最后那份', () => {
    const session = boot();
    // 走一遍五步，把每一层（含初始那层）的读数逐层记下来当期望值——
    // 只比"退到底"会放过一份跳步的实现（一次退两层、再下一次补三层，看起来也自洽）。
    const trail: PdfEditDraft[] = [session.draft()];
    expect(session.addOverlay(box('a'))).toBe(true);
    trail.push(session.draft());
    expect(session.addOverlay(box('b', { pageNumber: 2 }))).toBe(true);
    trail.push(session.draft());
    expect(session.moveOverlay('a', movedRect)).toBe(true);
    trail.push(session.draft());
    expect(session.setPageOrder([3, 2, 1])).toBe(true);
    trail.push(session.draft());
    expect(session.removeOverlay('b')).toBe(true);
    trail.push(session.draft());
    expect(session.canRedo()).toBe(false);

    for (let step = 4; step >= 0; step -= 1) {
      expect(session.undo()).toBe(true);
      expect(session.draft()).toEqual(trail[step]);
    }
    expect(session.canUndo()).toBe(false);
    expect(session.undo()).toBe(false);

    // 重做也要五层：退到底时最后那一份读数同样被推进了 future，少 redo 一次就还留一层。
    for (let step = 1; step <= 5; step += 1) {
      expect(session.redo()).toBe(true);
      expect(session.draft()).toEqual(trail[step]);
    }
    expect(session.canRedo()).toBe(false);
    expect(session.redo()).toBe(false);
  });

  it('撤销一步只退一个动作：覆盖区退回旧坐标时页序不动（一份快照覆盖整个 draft）', () => {
    const session = boot({ overlays: [box('a')], pageOrder: [1, 2, 3] });
    expect(session.setPageOrder([2, 1, 3])).toBe(true);
    expect(session.moveOverlay('a', movedRect)).toBe(true);

    expect(session.undo()).toBe(true);
    expect(session.draft()).toEqual({ overlays: [box('a')], pageOrder: [2, 1, 3] });

    expect(session.undo()).toBe(true);
    expect(session.draft()).toEqual({ overlays: [box('a')], pageOrder: [1, 2, 3] });
  });

  it('退回去之后再做一次编辑，重做分支作废（不许出现"跳过新编辑往前冲"的历史）', () => {
    const session = boot();
    session.addOverlay(box('a'));
    session.addOverlay(box('b'));
    expect(session.undo()).toBe(true);
    expect(session.canRedo()).toBe(true);

    expect(session.addOverlay(box('c'))).toBe(true);
    expect(session.canRedo()).toBe(false);
    expect(session.draft().overlays.map((overlay) => overlay.id)).toEqual(['a', 'c']);
  });
});

describe('空编辑与非法输入都不该长出撤销单元', () => {
  it('重复的 id：拒，且历史深度不变', () => {
    const session = boot({ overlays: [box('a')] });
    expect(session.canUndo()).toBe(false);

    expect(session.addOverlay(box('a', { pageNumber: 2 }))).toBe(false);
    expect(session.canUndo()).toBe(false);
    expect(session.draft().overlays).toHaveLength(1);
  });

  it('白名单外的码位：会话与另存共用同一份判据，所以在这里就被拦住（不是到落盘才发现）', () => {
    const session = boot();
    expect(session.addOverlay(box('cn', { text: '覆盖 \ud83c\udf89' }))).toBe(false);
    expect(session.draft().overlays).toEqual([]);
    expect(session.canUndo()).toBe(false);
  });

  it('加到超出条数上限：第四条被同一份尺度拒掉', () => {
    const session = boot({ overlays: [box('a'), box('b'), box('c')] });
    expect(session.addOverlay(box('d'))).toBe(false);
    expect(session.draft().overlays).toHaveLength(3);
  });

  it('挪到原处、删掉不存在的 id、指回同一份页序：三种空编辑都返回 false', () => {
    const session = boot({ overlays: [box('a')], pageOrder: [1, 2, 3] });
    const before = session.draft();
    const sameRect = box('a').rect;

    expect(session.moveOverlay('a', sameRect)).toBe(false);
    expect(session.moveOverlay('查无此区', movedRect)).toBe(false);
    expect(session.removeOverlay('查无此区')).toBe(false);
    expect(session.setPageOrder([1, 2, 3])).toBe(false);
    expect(session.canUndo()).toBe(false);
    expect(session.draft()).toEqual(before);
  });

  it('非法页序（空数组与越界页号）：拒且页序不变', () => {
    const session = boot();
    expect(session.setPageOrder([])).toBe(false);
    expect(session.setPageOrder([1, 9])).toBe(false);
    expect(session.draft().pageOrder).toEqual([1, 2, 3]);
  });
});

describe('读数不可写穿', () => {
  it('拿到的 draft 是副本：改动手里的数组动不到会话里的状态，嵌套的覆盖区对象也不是同一只', () => {
    const session = boot({ overlays: [box('a')] });
    const snapshot = session.draft();
    (snapshot.overlays as PdfOverlayInput[]).push(box('b'));
    (snapshot.pageOrder as number[]).push(3);

    expect(session.draft()).toEqual({ overlays: [box('a')], pageOrder: [1, 2, 3] });
    // 嵌套那份也要另拷：只拷数组而把元素按引用搬过去，界面改一个框就写穿了历史。
    expect(snapshot.overlays[0]).not.toBe(session.draft().overlays[0]);
  });
});

/**
 * 窄出口的纯度（3.5-e 面板开始真的取这条出口，所以 §7.14 那条注释约束从此有了强制手段）。
 *
 * 为什么要钉：渲染层取的是 `@auto-cc/plugin-pdf-edit/edit-session` 这一条**子路径**，
 * 一旦被引进来一条 Node 内置模块或 `pdf-lib`，Vite 就会把整支 PDF 引擎打前端 bundle——
 * 表现不是报错而是首屏体积暴涨，等发现时已经进了主干。这条用例是唯一能在提交前拦住它的东西。
 * @param text 源码文本
 * @returns 运行期真的会执行的 import 的模块说明符（`import type` 那些擦除后不存在，不计）
 */
function runtimeSpecifiers(text: string): string[] {
  return [...text.matchAll(/import\s+(?!type\s)[^;]*?\sfrom\s*'([^']+)'/g)].map((match) => match[1] as string);
}

describe('窄出口的纯度：渲染层取 `./edit-session` 不该把 PDF 引擎与 Node 能力一起拖进 bundle', () => {
  /**
   * 闭包内的运行期模块：`edit-session.ts` 自己 + 它真的算进来的那些纯模块。
   * 3.5-14 起多了一支 `overlay-colors.ts`（`overlay-writer.ts` 要它归一颜色）——它同样一条 Node 依赖都不许有，
   * 所以列进来而不是加进白名单：列进来才会被这一句扫一遍它自己的 import。
   * 3.5-15 同理再列一支 `text-metrics.ts`（字族档的白名单与基线回落那一套，渲染层与主进程共用同一个出处）。
   */
  const closureFiles = ['edit-session.ts', 'page-ops.ts', 'overlay-writer.ts', 'overlay-colors.ts', 'text-metrics.ts'];
  /**
   * 允许的运行期依赖：只有那条纯历史栈的窄子路径，加闭包内部的相对模块。
   * 写成正向白名单而不是禁止清单——新增一条越界依赖（`pdf-lib`、`node:fs`、带 `readBoundedFile` 的服务文件）
   * 会让这一句直接红，而禁止清单总会漏掉没想到的新名字。
   */
  const allowedRuntime = [
    '@auto-cc/core/snapshot-stack',
    ...closureFiles.map((name) => `./${name.replace('.ts', '.js')}`),
  ];

  it('闭包里每一条运行期 import 都在白名单上（`import type` 擦除后不存在，不计）', () => {
    for (const name of closureFiles) {
      const text = readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
      const offenders = runtimeSpecifiers(text).filter((specifier) => !allowedRuntime.includes(specifier));
      expect(offenders, `${name} 越界的运行期依赖`).toEqual([]);
    }
  });
});
