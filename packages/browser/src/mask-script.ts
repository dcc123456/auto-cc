/**
 * 注入到内核视图里的**截图前遮罩脚本**（spec 2.7-07）。
 *
 * 为什么是「盖住像素」而不是「把文本换成 `***`」：改站点 DOM 的文本会留下三处说不清——
 * 站点自己的脚本可能把内容刷回来、我们读到的正文与用户看到的不一致、以及「到底改了什么」
 * 在事后无法复原。往命中文本的位置上叠一块实心 div，页面内容一个字没动，截完把 div 摘掉，
 * 现场就回到原样（单测与验收都断言了这一点）。
 *
 * 判据不在这份文件里：`PII_VALUE_PATTERNS`（`@auto-cc/core`）是唯一的一份，
 * 这里把它的**源码字符串**内联进生成的脚本——页面上下文没有模块系统，只能带源码过去，
 * 而带过去的是同一份，不是抄的第二份（AGENTS.md §2.1 / §2.3）。
 */
import { PII_VALUE_PATTERNS } from '@auto-cc/core';

/** 遮罩块的标记属性，摘除时按它找自己盖了什么（不碰站点自己的节点）。 */
export const PII_MASK_ATTR = 'data-auto-cc-mask';

/** 遮罩脚本在页面里的返回值。 */
export type MaskScriptResult = {
  /** 命中的个人信息条数（一条可以跨多行，每行一块遮罩） */
  hits: number;
  /** 实际盖上去的遮罩块数量 */
  covers: number;
};

/**
 * 生成「盖住页面上以文本出现的个人信息」的表达式源码。
 *
 * 求值返回 Promise：注入之后等一帧真的画出来再截图，否则 `capturePage()` 取到的还是旧画面。
 * 但**不能只等 rAF**——内核视图可以在后台（1.6 起视图可见性是开关），隐藏视图的合成器不保证
 * 按帧回调，rAF 可能迟迟不来，于是这条等待和 `paintTimeoutMs` 赛跑：谁先到就用谁，等待有上界。
 * @param paintTimeoutMs 等待绘制的上限（毫秒），来自 `browser.page` 配置（不在代码里写死，见 spec 2.7-04）
 * @returns 单个表达式字符串，供 `evaluateInFrames` 以 `awaitPromise: true` 求值
 */
export function buildMaskScript(paintTimeoutMs: number): string {
  return `(async () => {
    const patterns = ${JSON.stringify(PII_VALUE_PATTERNS)};
    const MARK = ${JSON.stringify(PII_MASK_ATTR)};
    const root = document.body || document.documentElement;
    if (!root) return { hits: 0, covers: 0 };
    // 幂等：重复调用只重排自己盖的块，不会在遮罩上再叠一层，也不会把上一次的块算成站点内容。
    document.querySelectorAll('[' + MARK + ']').forEach((node) => node.remove());
    const textNodes = [];
    const stack = [root];
    while (stack.length > 0) {
      const branch = stack.pop();
      const children = branch.childNodes || [];
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        if (child.nodeType === 3) textNodes.push(child);
        else if (child.childNodes && child.childNodes.length > 0) stack.push(child);
      }
    }
    let hits = 0;
    let covers = 0;
    for (const textNode of textNodes) {
      const text = textNode.nodeValue || '';
      if (!text) continue;
      for (const pattern of patterns) {
        const re = new RegExp(pattern.source, pattern.flags);
        let match;
        while ((match = re.exec(text))) {
          hits += 1;
          // Text 节点没有 getClientRects()，取它上面那段字符的矩形只能造 Range。
          const range = document.createRange();
          range.setStart(textNode, match.index);
          range.setEnd(textNode, match.index + match[0].length);
          const rects = range.getClientRects();
          for (let rectIndex = 0; rectIndex < rects.length; rectIndex += 1) {
            const rect = rects[rectIndex];
            // 宽度为 0 的矩形是 <script> 里的文本、display:none 的节点，没有像素可盖。
            if (rect.width <= 0 || rect.height <= 0) continue;
            const cover = document.createElement('div');
            cover.setAttribute(MARK, pattern.kind);
            cover.style.cssText = 'position:absolute;left:' + (rect.left + window.scrollX) + 'px;top:' +
              (rect.top + window.scrollY) + 'px;width:' + rect.width + 'px;height:' + rect.height +
              'px;background:#111;z-index:2147483647;pointer-events:none;';
            root.appendChild(cover);
            covers += 1;
          }
        }
      }
    }
    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve(undefined);
      };
      setTimeout(done, ${String(paintTimeoutMs)});
      requestAnimationFrame(() => requestAnimationFrame(done));
    });
    return { hits, covers };
  })()`;
}

/**
 * 生成「摘掉自己盖的遮罩块」的表达式源码。
 *
 * 单独一条脚本而不是让遮罩脚本自我定时清理：截图这一步失败（空图、视图销毁）时也要能摘，
 * 所以摘的动作必须在 `finally` 里由主进程再发一次，而不是依赖页面里那段代码跑完。
 * @returns 单个表达式字符串，求值得到摘掉的块数
 */
export function buildUnmaskScript(): string {
  return `(() => {
    const MARK = ${JSON.stringify(PII_MASK_ATTR)};
    const nodes = document.querySelectorAll('[' + MARK + ']');
    const removed = nodes.length;
    nodes.forEach((node) => node.remove());
    return { removed };
  })()`;
}
