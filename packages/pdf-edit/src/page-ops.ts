/**
 * 页序模型（spec 3.5-07「页面增删/重排可用」的判定半边，plan §7.4 的 `setPageOrder` 那一格）。
 *
 * **一只数组表达三种操作**：`pageOrder[k]` 表示产物的第 k+1 页取自**源文件的第几页**（1 起）。
 * 于是删页＝少写一项、增页＝把同一项写两次（副本与原件内容流相同，正是"再来一页同样的底子"这个需求），
 * 重排＝换个顺序。为什么要收成一个入口而不是 `addPage` / `removePage` / `movePage` 三只：
 * ① plan §7.4 的 API 面本来就只登记了 `setPageOrder`；
 * ② 三只动作要各自回答"撤销一步退到哪儿"，而一份页序快照天然被历史栈（`createSnapshotStack`）覆盖；
 * ③ 三只入口之间会互相造出对方不认的中间态（比如删掉一页之后另两只的页号算谁的）。
 *
 * 覆盖区**不按产物页号绑，而是按来源页号绑**（见 `pdf-document.ts` 的 `applyOverlays`）：
 * 同一源的副本带的是同一段原文，要盖住那句旧话就得每份副本都盖上，否则"改了一份、另一份还露着"。
 */

/** 页序被拒的三种原因（各自对应界面一句话，所以不合并）。 */
export type PageOrderRejection =
  | { readonly ok: false; readonly code: 'empty-order'; readonly detail: string }
  | { readonly ok: false; readonly code: 'page-out-of-range'; readonly detail: string }
  | { readonly ok: false; readonly code: 'too-many-pages'; readonly detail: string };

/** 页序的判定结果：通过时带一份规整过的副本。 */
export type PagePlanOutcome = { readonly ok: true; readonly order: readonly number[] } | PageOrderRejection;

/**
 * 拒绝项的构造口（收成一个，避免三条腿各写一份 `{ ok: false, ... }` 而漏掉某一条）。
 * @param code 机器码
 * @param detail 技术原因（中文提示由服务层决定）
 * @returns 带 `ok: false` 的拒绝项
 */
function reject(code: PageOrderRejection['code'], detail: string): PageOrderRejection {
  return { ok: false, code, detail };
}

/**
 * 校验并规整一份页序。
 * @param order 产物逐页的来源页号（1 起，允许重复＝增页，允许缺项＝删页）
 * @param sourcePageCount 源文件的页数（页号的上界）
 * @param maxPages 产物页数上限（渲染层传进来的外部输入，不设界等于让它用一只数组把主进程的内存顶满）
 * @returns 通过给规整后的副本；否则给三种拒绝原因之一，**不抛异常**
 */
export function planPageOrder(order: readonly number[], sourcePageCount: number, maxPages: number): PagePlanOutcome {
  if (order.length === 0) return reject('empty-order', '页序为空会产出一份没有页的 PDF');
  if (order.length > maxPages)
    return reject('too-many-pages', `产物页数 ${String(order.length)} 超过上限 ${String(maxPages)}`);
  for (const pageNumber of order) {
    // 非整数与越界都拒：`copyPages` 拿 NaN 会得到 undefined 页，到绘制那一步才炸就成半成品了。
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > sourcePageCount) {
      return reject('page-out-of-range', `页号 ${String(pageNumber)} 不在源文件的 1…${String(sourcePageCount)} 之内`);
    }
  }
  return { ok: true, order: [...order] };
}

/**
 * 这份页序就是"不动"吗（原页序时走直通，不必把整份文档重拷一遍）。
 * @param order 待判页序
 * @param sourcePageCount 源文件的页数
 * @returns 逐位都等于自身页号且长度相同才 true
 */
export function isIdentityOrder(order: readonly number[], sourcePageCount: number): boolean {
  return order.length === sourcePageCount && order.every((pageNumber, index) => pageNumber === index + 1);
}
