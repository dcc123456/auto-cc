/**
 * 测试侧「看 PDF 内容流里到底画了什么」的唯一通道（AGENTS.md §2.2：这条逻辑在编辑轨的两份测试里
 * 各要一次，第二次就抽公共层；住在 `@auto-cc/testing` 而不是被测包里，免得引擎包为测试背一个 `node:zlib`）。
 */
import { inflateSync } from 'node:zlib';

/**
 * 把 PDF 字节里的内容流摊平成一段可读文本。
 *
 * 为什么必须先解压再看：实测（本机 `pdf-lib` 1.17.1）`drawRectangle` / `drawText` 的落笔进的是
 * **新建**的那条内容流，而 pdf-lib 新建流默认带 `/Filter /FlateDecode`；装载进来的那条原流仍是原样。
 * 于是"直接在字节里找子串"会得到假阴性——把两种流都摊开，断言才判得出"到底画上没有"。
 * 另外两条同类实测（写断言前必须知道，否则会以为引擎没落笔）：`drawRectangle` 画的不是 `re` 操作符，
 * 而是 `1 0 0 1 x y cm` 平移 + `0 0 m / 0 h l / w 0 l / h` 折线；`drawText` 写的是 `<大写十六进制> Tj`；
 * 而操作符之间是**换行**分隔，所以断言要写成 `h\s+f` 这种带空白量的形式。
 * @param bytes PDF 字节（夹具或产物都可以）
 * @returns 原始字节文本 + 每条可解压流的文本，串成一段（只用来找子串，不做语法解析）
 */
export function pdfContentText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString('latin1');
  let out = raw;
  for (const match of raw.matchAll(/\/FlateDecode[^>]*>>\s*stream\r?\n/g)) {
    const start = (match.index ?? 0) + match[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    // 规范里 `endstream` 前面的行尾符不属于流数据，按整条剥；只剥一个字节可能吃掉真数据。
    const chunk = raw.slice(start, end).replace(/\r?\n$/, '');
    try {
      out += `\n${inflateSync(Buffer.from(chunk, 'latin1')).toString('latin1')}\n`;
    } catch {
      // 解压失败说明它不是内容流（图像流同样带 FlateDecode）：原样留着，让断言自然判不出。
      out += `\n${chunk}\n`;
    }
  }
  return out;
}
