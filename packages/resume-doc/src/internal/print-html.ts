/**
 * 生成轨「打印 HTML 装配」内部实现（spec 3.3-03 / 3.3-05 产出 HTML 的那一半）。
 *
 * 本文件产生完整 HTML 文档字符串，因此**必须**待在 `internal/`：`model.test.ts` 的 3.1-10 只扫 `src` 顶层，
 * 与 3.2 把模板排版细节放 `internal/templates.ts` 是同一道分层约束（渲染细节不外泄到模型门面）。
 * 门面 `../print.ts` 只做无 HTML 的读数与再导出。
 *
 * 设计依 plan §3.3 设计点 3：走 `preferCSSPageSize`，纸张与页边距由 HTML 里的 `@page` 承载（mm 原生单位，
 * 无需英寸换算、不在打印选项里散落魔法数），字体随包内嵌经 `@font-face` 声明，Chromium 打印时按用到的字形自动子集内嵌。
 */
import { resumeTemplate, type TemplateLocale } from '../template.js';
import type { ResumeDocument } from '../model.js';
import type { ResumePrintRequest } from '@auto-cc/shared';

/** 随包内嵌的简历正文字体族名（打印 HTML 与 CSS `font-family` 必须一致）。 */
const FONT_FAMILY = 'Noto Sans SC';

/**
 * 内嵌字体清单：中文主体（400/700）+ 拉丁子集（400/700，带 `unicode-range` 让数字/英文走更小的拉丁档）。
 * 文件名与 `resources/fonts/**` 一一对应；OFL 许可见 `LICENSES.md`。
 */
const EMBEDDED_FONTS = [
  { file: 'noto-sans-sc-chinese-simplified-400-normal.woff2', weight: 400, unicodeRange: null },
  { file: 'noto-sans-sc-chinese-simplified-700-normal.woff2', weight: 700, unicodeRange: null },
  { file: 'noto-sans-sc-latin-400-normal.woff2', weight: 400, unicodeRange: 'U+0000-00FF' },
  { file: 'noto-sans-sc-latin-700-normal.woff2', weight: 700, unicodeRange: 'U+0000-00FF' },
] as const;

/**
 * 把简历文档渲染成「可独立打印的完整 HTML 文档」。
 * 纸张/页边距/字号/行距全部取自 `doc.layout`（3.3-03「配置集中于模型、不散落魔法数」），
 * 并声明随包内嵌字体（3.3-05）；正文来自 `resumeTemplate.render`（沿用 3.2 的模板与 i18n）。
 * @param doc 简历文档
 * @param templateId 模板 id（未知则交由 `resumeTemplate.render` 抛出可读错误）
 * @param locale 渲染语言，决定 `@font-face` 命中的字形族与正文标签本地化（3.3 en 导出腿的服务对象）
 * @param fontBaseUrl 字体目录的绝对 base URL（dev 指向仓库 `resources/fonts`，打包态由 shell 指向 `process.resourcesPath`；本层不猜路径）
 * @returns 一个自足的 `<!doctype html>` 文档字符串
 */
export function buildPrintHtml(
  doc: ResumeDocument,
  templateId: string,
  locale: TemplateLocale,
  fontBaseUrl: string,
): string {
  const body = resumeTemplate.render(doc, templateId, locale);
  const { margin, baseFontPt, lineHeight, pageSize } = doc.layout;
  const faces = EMBEDDED_FONTS.map(
    (f) =>
      `@font-face{font-family:'${FONT_FAMILY}';font-weight:${f.weight};font-style:normal;` +
      `${f.unicodeRange ? `unicode-range:${f.unicodeRange};` : ''}src:url('${fontBaseUrl}/${f.file}') format('woff2');}`,
  ).join('');
  const pageRule = `@page{size:${pageSize};margin:${margin.topMm}mm ${margin.rightMm}mm ${margin.bottomMm}mm ${margin.leftMm}mm;}`;
  const baseRule = `html{font-family:'${FONT_FAMILY}',sans-serif;font-size:${baseFontPt}pt;line-height:${lineHeight};-webkit-print-color-adjust:exact;print-color-adjust:exact;}body{margin:0;}`;
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><style>${faces}${pageRule}${baseRule}</style></head><body>${body}</body></html>`;
}

/**
 * 组装「渲染 HTML + 打印选项」的完整打印请求，供 shell 的执行器 `loadURL` 后调用 `printToPDF`。
 * @param doc 简历文档
 * @param templateId 模板 id
 * @param locale 语言
 * @param fontBaseUrl 字体目录 base URL（见 {@link buildPrintHtml}）
 * @returns `{ html, options }`，二者都只由 `doc.layout` 决定，无隐藏魔法数（3.3-03）
 */
export function toPrintRequest(
  doc: ResumeDocument,
  templateId: string,
  locale: TemplateLocale,
  fontBaseUrl: string,
): ResumePrintRequest {
  return {
    html: buildPrintHtml(doc, templateId, locale, fontBaseUrl),
    options: {
      pageSize: doc.layout.pageSize,
      printBackground: true,
      preferCSSPageSize: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    },
  };
}
