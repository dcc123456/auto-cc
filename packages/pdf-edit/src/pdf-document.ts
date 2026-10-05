/**
 * 既有 PDF 的装载与另存（spec 3.4-03：`pdf-lib` 装载并生成合法 PDF；plan §7.3 的 `pdf-edit` 引擎腿）。
 *
 * 契约与生成轨**相反**，所以它是独立的一只包：`resume-doc` 的真相源是文档模型、PDF 是它的投影；
 * 这里的真相源是**用户手里那份文件**，没有模型可依赖（plan §7.3 的第一条理由）。
 * 降级裁定（2026-10-05）之后这是编辑轨唯一一条引擎腿：纯 JS、随 `app.asar` 内嵌、零 WASM、零原生编译，
 * 因此 `scripts/check-dependency-floor.ts` 的搬运层与 `scripts/check-licenses.ts` 都按现成的口判它（plan §7.7）。
 *
 * 反伪装约束（plan §7.6）：本层只**追加**内容，不改写原内容流——实测覆盖上去的白底矩形之下，
 * 旧文字仍可被提取。于是「旧文字已删除」这类说法在本包的任何返回字段与错误文案里都不许出现。
 */
import { sha256Hex } from '@auto-cc/core/file-read';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import type { PlannedOverlay } from './overlay-writer.js';

/** 装载不了的三种确定态（plan §7.10：加密文档与结构损坏都不试图绕过，也不产出半成品）。 */
export type PdfLoadFailure = 'empty' | 'encrypted' | 'invalid';

/** 一页的度量。单位是 pt（1 pt = 1/72 英寸），界面按 pt ↔ 比例坐标换算，见 plan §7.5。 */
export interface PdfPageMetric {
  /** 页序，从 1 开始（界面上人看到的是「第几页」，不是数组下标）。 */
  readonly number: number;
  readonly widthPt: number;
  readonly heightPt: number;
}

/** 装载的结果：成功带文档与来源哈希，失败带机器码与技术原因（中文提示由服务层决定）。 */
export type PdfLoadOutcome =
  | { readonly status: 'loaded'; readonly document: PdfEditDocument; readonly sourceHash: string }
  | { readonly status: 'failed'; readonly reason: PdfLoadFailure; readonly detail: string };

/**
 * 一份被装载起来、等着叠加内容的 PDF。
 *
 * 它**不是**会话模型：3.5-b 的 `edit-session` 才持有覆盖区列表与页面顺序，这一层只保证
 * 「读得进来、写得出去、读得出每页多大、把换算好的覆盖区追加到页上」——前人是 3.4-03 的判据，
 * 后一条是 3.5-02 的绘制半边。
 */
export class PdfEditDocument {
  private constructor(
    private readonly pdf: PDFDocument,
    private readonly metrics: readonly PdfPageMetric[],
  ) {}

  /**
   * 装载一份 PDF 字节。
   * @param bytes 文件字节（空串/空数组判为 `empty`，不当成合法的空 PDF）
   * @returns `loaded` 带文档与来源哈希；`empty` / `encrypted` / `invalid` 带技术原因，**不抛异常**
   */
  static async load(bytes: Uint8Array): Promise<PdfLoadOutcome> {
    if (bytes.length === 0) return { status: 'failed', reason: 'empty', detail: 'file is empty' };
    // 哈希在进入三方库之前算：与 4.1 的导入腿同一条顺序约束，字节被消费之后再摘要就是空壳。
    const sourceHash = sha256Hex(bytes);
    try {
      // 交给三方库前先复制一份（同 `source.ts` 的抽取腿）：解析失败或内部缓冲移交都不该动到调用方手里的原件。
      // `ignoreEncryption: true` 只为了让下面那一句读得到 `isEncrypted`，而不是「解析都失败在同一个异常里」——
      // 加密与损坏在界面上的处置不同（一条要用户去解密，一条是文件本身坏了），所以先分开判。
      const pdf = await PDFDocument.load(bytes.slice(0), { ignoreEncryption: true });
      if (pdf.isEncrypted) return { status: 'failed', reason: 'encrypted', detail: 'document is encrypted' };
      // 结构探针：实测（本机 pdf-lib 1.17.1）一份 `%PDF-1.4` 开头、后面全是垃圾字节的文件**装得上**，
      // 崩的是下一步取页对象。所以"能不能读"必须在这里当场量一遍，量不出页面的文件一律算 `invalid`——
      // 放一份「装得上但没有页」的文档走出去，3.5-b 就会在另存时产出半成品（plan §7.10 要拦的正是这个）。
      const metrics = pdf
        .getPages()
        .map((page, index) => ({ number: index + 1, widthPt: page.getWidth(), heightPt: page.getHeight() }));
      return { status: 'loaded', document: new PdfEditDocument(pdf, metrics), sourceHash };
    } catch (error) {
      return { status: 'failed', reason: 'invalid', detail: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 这份文档的页数（与 `pageMetrics()` 同源：度量在装载时就量好了，这里不再解析第二遍）。 */
  get pageCount(): number {
    return this.metrics.length;
  }

  /**
   * 逐页量出的宽高。
   * @returns 按页序排列的度量，页号从 1 开始
   */
  pageMetrics(): readonly PdfPageMetric[] {
    return this.metrics;
  }

  /**
   * 把换算好的覆盖区追加到各自那一页上（spec 3.5-02 的「叠加」半边）。
   *
   * 只有这一处碰 `pdf-lib` 的绘制 API，因为它决定了两件必须写死的事：
   * ① 白底矩形必须 `borderWidth: 0`——实测（本机 `pdf-lib` 1.17.1 的 `PDFPageOptions.d.ts`）
   *    `drawRectangle` 的默认描边宽是 1 pt，留着它就成了一圈黑框，而覆盖区的作用是垫一块干净的底；
   * ② 文字走 `StandardFonts.Helvetica`（零内嵌成本）。**实测更正**：`drawText` 的 `font` 只收 `PDFFont`，
   *    不收 `StandardFonts` 枚举，所以标准字体也要先 `embedFont` 一次拿到句柄——整场只嵌一次，
   *    不是因为嵌多次会坏，而是因为一次都不该多。越界的中文早在 `planOverlays` 就被挡下了，
   *    这里不再校验字形覆盖（plan §7.2 结论③：标准字体没有 CJK 字形，硬画得到豆腐块）。
   * @param plans `planOverlays` 通过校验并换算好的覆盖区（PDF 坐标，页号从 1 起）
   * @throws 页号越界时抛普通 `Error`（那是调用方拿了别的文档的计划过来，属编程错误）；
   *         连同 `pdf-lib` 自己的绘制异常一起由服务层收敛成 `PDF_EDIT_SAVE_FAILED`，**不落半成品**
   */
  async applyOverlays(plans: readonly PlannedOverlay[]): Promise<void> {
    const pages = this.pdf.getPages();
    const latinFont = plans.some((plan) => plan.text !== undefined)
      ? await this.pdf.embedFont(StandardFonts.Helvetica)
      : undefined;
    for (const plan of plans) {
      const page = pages[plan.pageNumber - 1];
      // 越界一律抛，不许静默跳过：跳过等于产出一份「看似改过实则少画几区」的文件（3.5-05 转移来的那条精神）。
      if (page === undefined)
        throw new Error(`覆盖区 ${plan.id} 指向第 ${String(plan.pageNumber)} 页，本档只有 ${String(pages.length)} 页`);
      page.drawRectangle({
        x: plan.xPt,
        y: plan.yBottomPt,
        width: plan.widthPt,
        height: plan.heightPt,
        color: rgb(1, 1, 1),
        borderWidth: 0,
      });
      if (plan.text !== undefined && plan.textBaselinePt !== undefined && latinFont !== undefined) {
        page.drawText(plan.text, { x: plan.xPt, y: plan.textBaselinePt, size: plan.sizePt, font: latinFont });
      }
    }
  }

  /**
   * 生成新的 PDF 字节（3.4-03 的「生成合法 PDF」半边）。
   *
   * 每次调用都产出一份新副本，源文件从头到尾没被打开过第二回（spec 3.5-09「产物不污染源文件」）。
   * @returns 可直接落盘的字节
   */
  async save(): Promise<Uint8Array> {
    return this.pdf.save();
  }
}
