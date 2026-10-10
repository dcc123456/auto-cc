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
import { PRINT_STYLESHEET } from './print-css.js';
import { designVarEntries, PAPER_VAR_NAME } from './design-slots.js';
import type { DocumentDesign, ResumeDocument } from '../model.js';
import type { ResumePrintRequest } from '@auto-cc/shared';

/** 随包内嵌的简历正文字体族名（打印 HTML 与 CSS `font-family` 必须一致）。 */
const SANS_FONT_FAMILY = 'Noto Sans SC';
/**
 * 衬线模板（`TemplateSpec.serif`）那一族的族名，与 `print-css.ts` 的 `font-serif` 声明逐字对齐。
 * 这一支此前只是**被声称**而没随包（`EMBEDDED_FONTS` 里只有 Sans）：Georgia / Times New Roman 都不含汉字，
 * 于是 11 套衬线模板的中文静默掉回系统衬线，而拉丁正常——看起来就是「这套模板没做完整」（spec 6.6-04）。
 */
const SERIF_FONT_FAMILY = 'Noto Serif SC';

/** 一条 `@font-face` 声明：族名 + 文件名 + 字重 + 可选 `unicode-range`。 */
interface EmbeddedFont {
  /** CSS 族名，必须与 `print-css.ts` 里 `font-sans` / `font-serif` 声称的那个逐字相同。 */
  readonly family: string;
  /** `resources/fonts/**` 下的文件名。 */
  readonly file: string;
  readonly weight: number;
  /** `null` = 整族兜底（中文主体）；字符串 = 只服务这一段码位（拉丁子集档）。 */
  readonly unicodeRange: string | null;
}

/**
 * 内嵌字体清单：正体与衬线各一组「中文主体（400/700）+ 拉丁子集（400/700，带 `unicode-range` 让数字/英文走更小的拉丁档）」。
 * 文件名与 `resources/fonts/**` 一一对应；OFL 许可见 `LICENSES.md`。
 */
const EMBEDDED_FONTS: readonly EmbeddedFont[] = [
  {
    family: SANS_FONT_FAMILY,
    file: 'noto-sans-sc-chinese-simplified-400-normal.woff2',
    weight: 400,
    unicodeRange: null,
  },
  {
    family: SANS_FONT_FAMILY,
    file: 'noto-sans-sc-chinese-simplified-700-normal.woff2',
    weight: 700,
    unicodeRange: null,
  },
  { family: SANS_FONT_FAMILY, file: 'noto-sans-sc-latin-400-normal.woff2', weight: 400, unicodeRange: 'U+0000-00FF' },
  { family: SANS_FONT_FAMILY, file: 'noto-sans-sc-latin-700-normal.woff2', weight: 700, unicodeRange: 'U+0000-00FF' },
  {
    family: SERIF_FONT_FAMILY,
    file: 'noto-serif-sc-chinese-simplified-400-normal.woff2',
    weight: 400,
    unicodeRange: null,
  },
  {
    family: SERIF_FONT_FAMILY,
    file: 'noto-serif-sc-chinese-simplified-700-normal.woff2',
    weight: 700,
    unicodeRange: null,
  },
  { family: SERIF_FONT_FAMILY, file: 'noto-serif-sc-latin-400-normal.woff2', weight: 400, unicodeRange: 'U+0000-00FF' },
  { family: SERIF_FONT_FAMILY, file: 'noto-serif-sc-latin-700-normal.woff2', weight: 700, unicodeRange: 'U+0000-00FF' },
];

/**
 * 内嵌字体集的稳定标识（逐族名 + 逐档文件名）——快照（3.7-01）据此记录「这份 PDF 由哪套字体产出」。
 * 与 `@font-face` 声明同源于本文件，于是「产物的字体」与「快照里的字体集」永远指同一份清单，不会各写各的。
 */
export const FONT_SET_ID = `${[...new Set(EMBEDDED_FONTS.map((f) => f.family))].join('+')}:${EMBEDDED_FONTS.map(
  (f) => f.file,
).join(',')}`;

/**
 * 样式层在**产物文档级**落下的那一小块 `<style>`（spec 6.6-02 的后半边，也是全份产物里唯一允许出现
 * 用户所选颜色的位置）。
 *
 * 为什么必须走这一支而不是让模板自己写颜色：`resumeTemplate.render` 的片段受 3.2-07 约束
 * （不得出现 `style="` 与 `<style>`，`template.test.ts` 逐条机检），而 50 套模板只有一条装配路径；
 * 于是「用户选了什么颜色」这件事在 CSS 层被拆成两半——模板挂的是**恒定存在**的槽位类（`design-slots.ts`），
 * 值由这里发到 `:root` 的变量上。改一次颜色不需要重编译任何样式表，产物里变的只有这一小块。
 *
 * 顺序裁定的另一半：这一支排在 `PRINT_STYLESHEET` **之后**。槽位类与模板自带的 `text-neutral-700`
 * 同特异度（0,1,0），CSS 在同特异度时按出现次序决胜，所以只有排在这后面的槽位规则才赢得过模板默认档。
 * @param design 文档主题（可缺省）
 * @returns 一小段 CSS；无主题或一条轴都没设时返回空串，于是产物与样式层落地前**逐字节相同**
 */
function designStyleBlock(design: DocumentDesign | undefined): string {
  const vars = designVarEntries(design);
  const entries = Object.entries(vars);
  if (entries.length === 0) return '';
  const rootRule = `:root{${entries.map(([name, value]) => `${name}:${value};`).join('')}}`;
  // 纸底色没有对应的 class 槽：它落在 `body` 上——屏幕上那张纸的整个 padding 区（6.6-03 那条 `@media screen`
  // 的边距）与打印出去的整页底必须是同一个色，而这两者都只有 `body` 能盖住。
  const paperRule = vars[PAPER_VAR_NAME] === undefined ? '' : `body{background-color:var(${PAPER_VAR_NAME});}`;
  return `${rootRule}${paperRule}`;
}

/**
 * 把简历文档渲染成「可独立打印的完整 HTML 文档」。
 * 纸张/页边距/字号/行距全部取自 `doc.layout`（3.3-03「配置集中于模型、不散落魔法数」），
 * 并声明随包内嵌字体（3.3-05）；正文来自 `resumeTemplate.render`（沿用 3.2 的模板与 i18n）。
 * @param doc 简历文档
 * @param templateId 模板 id（未知则交由 `resumeTemplate.render` 抛出可读错误）
 * @param locale 渲染语言，决定 `@font-face` 命中的字形族与正文标签本地化（3.3 en 导出腿的服务对象）
 * @param fontBaseUrl 字体目录 base（不带结尾斜杠），本层不猜路径。两支消费者给的是**两种形状**，各有所据：
 *   打印面必须给绝对 `file://`（执行器把 HTML 落到临时目录再经 `file://` 装载，只有同源文档才允许读本地字体，
 *   `data:`/相对路径在那一面都无源可溯）；预览面必须给相对路径（`@auto-cc/shared` 的 `PREVIEW_FONT_BASE`）——
 *   纸面是渲染层里的 `about:srcdoc` 帧，它继承渲染层根目录作 baseURI，于是同一条相对路径在 dev（vite 根）
 *   与装机（`file://…/renderer/index.html`）两种运行态各自落到真实存在的字体文件上。
 * @returns 一个自足的 `<!doctype html>` 文档字符串
 */
export function buildPrintHtml(
  doc: ResumeDocument,
  templateId: string,
  locale: TemplateLocale,
  fontBaseUrl: string,
): string {
  const body = resumeTemplate.render(doc, templateId, locale);
  const { margin, baseFontPt, lineHeight, pageSize, design } = doc.layout;
  const faces = EMBEDDED_FONTS.map(
    (f) =>
      `@font-face{font-family:'${f.family}';font-weight:${f.weight};font-style:normal;` +
      `${f.unicodeRange ? `unicode-range:${f.unicodeRange};` : ''}src:url('${fontBaseUrl}/${f.file}') format('woff2');}`,
  ).join('');
  const marginSpec = `${margin.topMm}mm ${margin.rightMm}mm ${margin.bottomMm}mm ${margin.leftMm}mm`;
  const pageRule = `@page{size:${pageSize};margin:${marginSpec};}`;
  // 分页护栏（3.3-08）：单条经历整体不跨页（break-inside:avoid），区块标题不被甩到页尾成孤儿（break-after:avoid）。
  const breakRule = '.resume-entry{break-inside:avoid;}h2{break-after:avoid;}';
  // 最小归零（Tailwind preflight 的那一小截）：产物文档里没有 preflight，浏览器默认的 h1/h2/p 外边距
  // 会把模板写的间距全部顶开，于是"每套模板画得不一样"这条判据根本量不出来。
  const resetRule =
    '*{box-sizing:border-box;margin:0;padding:0;}h1,h2,h3,p{font-size:inherit;font-weight:inherit;line-height:inherit;}ul,ol{list-style:none;}';
  const baseRule = `html{font-family:'${SANS_FONT_FAMILY}',sans-serif;font-size:${baseFontPt}pt;line-height:${lineHeight};-webkit-print-color-adjust:exact;print-color-adjust:exact;}body{margin:0;}`;
  // 屏幕上的那张纸必须自己把边距吃进去：`@page` **只对分页媒体生效**（Chromium 打印时才读它），而纸面槽
  // 挂的是 `<iframe srcDoc class="w-[210mm]">`（`ResumePaperStage.tsx:208-215`），上面那条 `body{margin:0}`
  // 在屏幕上就成了"正文一路顶到纸边"，而同一份 HTML 打出来却有 14/16mm——人骂的页边距其实是这两张纸不一样。
  // 边距仍然只有 `doc.layout.margin` 一个来源（3.3-03 的「不散落魔法数」），打印那一支显式归零，
  // 免得被读成「@page + padding 双份边距」；打印选项里钉死的 `margins:{0,0,0,0}` 一字未动。
  const screenMarginRule = `@media screen{body{padding:${marginSpec};}}@media print{body{padding:0;}}`;
  // 工具类样式表排在最后：模板按 3.2-07 用 utility class 表达版面，而这份文档不经过渲染层那条编译链，
  // class 只有在产物里带上对应规则才算数（缺它时三套模板导出像素相同，见 print-css.ts 文件头）。
  // 样式层再往后一档：`:root` 的那些变量与 `body` 的纸底色必须与 `rz-*` 槽位同块同源（见 `designStyleBlock`），
  // 无主题时它是空串，所以下面这一条拼接不改变"没设样式层的文档"的一个字节。
  const designRule = designStyleBlock(design);
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><style>${faces}${pageRule}${breakRule}${baseRule}${screenMarginRule}${resetRule}${PRINT_STYLESHEET}${designRule}</style></head><body>${body}</body></html>`;
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
