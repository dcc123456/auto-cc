/**
 * 生成轨打印「端口契约」跨层类型（plan §3.3 分层落点：HTML 装配在 L2 `resume-doc`，`printToPDF` 在 L1 `shell`）。
 *
 * 为什么放 `@auto-cc/shared`：L1 与 L2 都只依赖它、互不 import（L1 禁止反向依赖 L2，见 AGENTS.md §4.1）。
 * 打印执行要碰 `WebContents`（Electron），而 `resume-doc` 刻意不含 electron 依赖——于是把「唯一需要内核环境」
 * 的两件事（渲染字节、字体目录 base）抽成这个端口，由 shell 实现、resume-doc 经 cordis 依赖注入消费。
 * 这里除下面那一个**目录名常量**外没有任何运行时代码，也不 import electron（`render` 返回 `Uint8Array` 而非 Electron 的 `Buffer` 别名）。
 */

/**
 * 预览 HTML 里字体 `src` 的**相对** base（不带斜杠）：渲染层根目录下的字体子目录名。
 *
 * 为什么预览不能沿用端口的 `fontBaseUrl()`（绝对 `file://`）：纸面是渲染层里的 `about:srcdoc` 帧，
 * 而开发态的渲染层跑在 `http://127.0.0.1:5173/`——从 http 页面里取 `file://` 资源会被 Chromium 直接挡掉
 * （实测 `document.fonts.load('40px "Noto Sans SC"')` 回 `NetworkError`），于是**屏上预览一路用系统回退字体，
 * 只有导出的 PDF 才是内嵌字体**，3.3-01「预览即导出所见」在字形这一维不成立（spec 6.6-04 的那半条报障）。
 * 相对路径把这一支换到渲染层自己的根上：dev 由 vite 中间件从仓库 `resources/fonts` 直接送出，
 * 装机版由 `vite build` 搬进渲染层产物根的 `fonts/`（同一套做法的先例是 `pdfjs/` 那棵树，
 * 见 `packages/renderer/vite-static-assets.ts`）。
 * **一条实测补上的必要条件**（原判断"换成相对就两边都对"不完整）：纸面帧是 `sandbox=""` 的 srcdoc，
 * 它**没有来源**，于是那条相对字体的请求是跨源取（`Origin: null`）并按 CORS 校验——
 * 中间件不发 `Access-Control-Allow-Origin` 时相对路径照样 `NetworkError`（两处必须一起成立，见上面那个文件）。
 * 装机那一半（`file://` 根 + `font-src 'self'`）本轮未取读数，见 spec 6.6-04 底下那条 `[!]`。
 *
 * **这一支目录名与渲染层构建侧写死的字面量必须一致**（构建侧引不到这里：vite 配置文件只内联相对 import，
 * 而 `@auto-cc/shared` 的包入口在 node 下解析不了 `./print.js`），改动时两处一起改。
 */
export const PREVIEW_FONT_BASE = 'fonts';

/**
 * `printToPDF` 的调用选项（本地结构类型，刻意不 import electron：本契约两端都不认识 Electron 类型）。
 * `preferCSSPageSize` 为真时 `pageSize`/`margins` 由 HTML 里的 `@page` 覆盖；这里仍显式给出 A4 + 边距归零，
 * 与 plan「页边距归零 + A4 + preferCSSPageSize」口径一致，避免双份边距。
 */
export interface ResumePrintOptions {
  pageSize: 'A4';
  printBackground: boolean;
  preferCSSPageSize: boolean;
  margins: { top: number; bottom: number; left: number; right: number };
}

/** 一份可被打印执行器直接消费的请求：完整 HTML 文本 + 打印选项。 */
export interface ResumePrintRequest {
  html: string;
  options: ResumePrintOptions;
}

/**
 * 打印端口：把「渲染 HTML」交给内核产出 PDF 字节，并交代只有内核环境才知道的字体目录位置。
 * 实现方（L1 shell）是唯一碰 `WebContents.printToPDF` 的地方；消费方（L2 `resume.export`）只认这个接口。
 */
export interface ResumePrintPort {
  /**
   * 随包内嵌字体目录的 `file://` base URL（dev 指向仓库 `resources/fonts`，打包态指向 `process.resourcesPath/fonts`）。
   * @returns 供打印 HTML 里 `@font-face` 拼接的绝对 base（不带结尾斜杠）
   */
  fontBaseUrl(): string;

  /**
   * 在隐藏视图里把一份完整打印 HTML 渲染成 PDF 字节。
   * @param request {@link ResumePrintRequest}：HTML 与打印选项
   * @returns 产物 PDF 的字节；实现方不落盘、不改文档，只做「HTML 进、PDF 出」这一件事
   */
  render(request: ResumePrintRequest): Promise<Uint8Array>;
}
