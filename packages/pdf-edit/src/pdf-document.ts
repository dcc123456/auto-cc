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
import { PDFDocument } from 'pdf-lib';

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
 * 「读得进来、写得出去、读得出每页多大」，正好是 3.4-03 那条判据要求引擎具备的三件事。
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
   * 生成新的 PDF 字节（3.4-03 的「生成合法 PDF」半边）。
   *
   * 每次调用都产出一份新副本，源文件从头到尾没被打开过第二回（spec 3.5-09「产物不污染源文件」）。
   * @returns 可直接落盘的字节
   */
  async save(): Promise<Uint8Array> {
    return this.pdf.save();
  }
}
