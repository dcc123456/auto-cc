/**
 * 注入到内核视图里执行的**页面读取脚本**（spec 2.1-03）。
 *
 * 刻意做成「返回一段表达式字符串」而不是把逻辑写在主进程里：DOM 只在页面里存在，
 * 主进程拿到 HTML 字符串再解析就是第二套 DOM 实现（plan §8 明确禁止，且要引 cheerio/jsdom）。
 * 也因此这段源码可以被单测直接 `new Function` 跑起来——不需要真开一个 Electron 窗口。
 */

/** 正文文本的默认取回上限（字符）。整站内存里 `innerText` 可能是几百 KB，证据文件装不下也不该装。 */
export const SNAPSHOT_TEXT_LIMIT = 4000;

/** 标题节点最多取几条：够对照截图即可，面板不是大纲工具。 */
export const SNAPSHOT_HEADING_LIMIT = 12;

/** 页面读取结果（主进程侧看到的形状，与 `shared` 的视图类型一致）。 */
export type PageSnapshotReading = {
  title: string;
  url: string;
  readyState: 'loading' | 'interactive' | 'complete';
  elementCount: number;
  /** 截断前的正文长度，用于判断「取回的是不是一小段」。 */
  textLength: number;
  /** 截断后的正文文本。 */
  bodyText: string;
  headings: string[];
};

/**
 * 生成一段在页面上下文里求值的表达式源码。
 * @param maxChars 正文取回上限（字符），由调用方钳制过范围
 * @param headingLimit 标题节点取回上限
 * @returns 单个表达式字符串，同时可用于 `webContents.executeJavaScript` 与单测里的 `new Function`
 */
export function buildSnapshotScript(maxChars: number, headingLimit: number): string {
  return `(() => {
    const bodyText = (document.body && document.body.innerText) || '';
    const headingNodes = document.querySelectorAll('h1, h2, h3');
    const headings = [];
    for (let index = 0; index < headingNodes.length && headings.length < ${String(headingLimit)}; index += 1) {
      const headingText = (headingNodes[index].textContent || '').replace(/\\s+/g, ' ').trim();
      if (headingText) headings.push(headingText);
    }
    return {
      title: document.title || '',
      url: location.href,
      readyState: document.readyState,
      elementCount: document.querySelectorAll('*').length,
      textLength: bodyText.length,
      bodyText: bodyText.slice(0, ${String(maxChars)}),
      headings,
    };
  })()`;
}

/**
 * 把注入结果钳成视图形状：页面里的值来自不可信环境（外部站点），缺字段就用中性值补，
 * 不让一个 undefined 把整次读取打崩（spec 2.1-03 要的是「读得出」，不是「读到零为止」）。
 * @param raw `executeJavaScript` 的返回值
 * @returns 字段齐全、类型确定的页面读数
 */
export function toSnapshotReading(raw: unknown): PageSnapshotReading {
  const value = (raw ?? {}) as Partial<PageSnapshotReading>;
  return {
    title: typeof value.title === 'string' ? value.title : '',
    url: typeof value.url === 'string' ? value.url : '',
    readyState: value.readyState === 'loading' || value.readyState === 'interactive' ? value.readyState : 'complete',
    elementCount: typeof value.elementCount === 'number' ? value.elementCount : 0,
    textLength: typeof value.textLength === 'number' ? value.textLength : 0,
    bodyText: typeof value.bodyText === 'string' ? value.bodyText : '',
    headings: Array.isArray(value.headings)
      ? value.headings.filter((item): item is string => typeof item === 'string')
      : [],
  };
}
