/**
 * 生成轨打印「端口契约」跨层类型（plan §3.3 分层落点：HTML 装配在 L2 `resume-doc`，`printToPDF` 在 L1 `shell`）。
 *
 * 为什么放 `@auto-cc/shared`：L1 与 L2 都只依赖它、互不 import（L1 禁止反向依赖 L2，见 AGENTS.md §4.1）。
 * 打印执行要碰 `WebContents`（Electron），而 `resume-doc` 刻意不含 electron 依赖——于是把「唯一需要内核环境」
 * 的两件事（渲染字节、字体目录 base）抽成这个端口，由 shell 实现、resume-doc 经 cordis 依赖注入消费。
 * 这里是**纯类型**，没有任何运行时代码，也不 import electron（`render` 返回 `Uint8Array` 而非 Electron 的 `Buffer` 别名）。
 */

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
