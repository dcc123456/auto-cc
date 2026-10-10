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
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb, StandardFonts, type PDFFont } from 'pdf-lib';
import { colorsOfOverlay } from './overlay-colors.js';
import { isLatinOnly, type PlannedOverlay } from './overlay-writer.js';
import { isIdentityOrder } from './page-ops.js';

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
 * 一份被装载起来、等着叠加内容与重排页序的 PDF。
 *
 * 它**不是**会话模型：3.5-c 的编辑会话才持有覆盖区列表与页序草稿，这一层只保证
 * 「读得进来、按页序拷得出、写得出去、读得出每页多大、把换算好的覆盖区追加到页上」——
 * 前人是 3.4-03 的判据，叠加是 3.5-02 的绘制半边，页序是 3.5-07 的引擎半边。
 */
export class PdfEditDocument {
  private constructor(
    private readonly pdf: PDFDocument,
    /** 源档逐页度量（`arrange()` 之后仍然指源档那一份：同一源的副本共用同一份量得）。 */
    private readonly sourceMetrics: readonly PdfPageMetric[],
    /**
     * 本文档逐页的**来源页号**（1 起）。装载时就是 `1…n`，`arrange()` 之后会带上重复项或缺项。
     * 覆盖区按它来认目标页，而不是按产物第几页——见 `page-ops.ts` 头部那条"同一源的副本都要盖上"。
     */
    private readonly pageSources: readonly number[],
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
      const pages = pdf.getPages();
      const metrics = pages.map((page, index) => ({
        number: index + 1,
        widthPt: page.getWidth(),
        heightPt: page.getHeight(),
      }));
      return {
        status: 'loaded',
        document: new PdfEditDocument(
          pdf,
          metrics,
          metrics.map((metric) => metric.number),
        ),
        sourceHash,
      };
    } catch (error) {
      return { status: 'failed', reason: 'invalid', detail: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 产物的页数（`arrange()` 之后可以比源档多、也可以比源档少：一项对应一页，重复项对应副本）。 */
  get pageCount(): number {
    return this.pageSources.length;
  }

  /** 源档的页数：覆盖区的页号与页序里的页号都以它为上界，`arrange()` 不改这个数。 */
  get sourcePageCount(): number {
    return this.sourceMetrics.length;
  }

  /**
   * **源档**逐页量出的宽高（不是产物逐页：产物里同一源的副本共用同一份量得）。
   * @returns 按源页序排列的度量，页号从 1 开始
   */
  sourcePageMetrics(): readonly PdfPageMetric[] {
    return this.sourceMetrics;
  }

  /**
   * 产物逐页的来源页号（3.5-07 判据里"顺序符合操作"就是拿它比）。
   * @returns 长度等于 `pageCount` 的页号数组，1 起
   */
  outputPageSources(): readonly number[] {
    return this.pageSources;
  }

  /**
   * 按页序拷出一份新文档（增页/删页/重排的引擎半边，spec 3.5-07）。
   *
   * 直通情形（页序就是 `1…n`）直接返回 `this`：`copyPages` 会把整份文档重嵌一遍资源，
   * 白拷一次不只是慢，还会让"没改页序的产物"与源档的字节结构无谓地不同。
   * @param order 逐页的来源页号（**已由 `planPageOrder` 校验过**：非空、每项落在 1…`sourcePageCount`）
   * @returns 页序生效后的新文档（源度量原样带过去，覆盖区的换算口径不变）；直通则返回自身
   * @throws `pdf-lib` 拷贝失败时抛出，由服务层收敛成 `PDF_EDIT_SAVE_FAILED`，**不落半成品**
   */
  async arrange(order: readonly number[]): Promise<PdfEditDocument> {
    if (isIdentityOrder(order, this.sourcePageCount)) return this;
    const target = await PDFDocument.create();
    // 实测（本机 `pdf-lib` 1.17.1）：`copyPages` 逐指标取一份新拷贝、对重复指标不设限，所以 `[0, 0, 1]` 得到三页
    // 而不是两页——这正是"同一页的副本内容流相同"这条覆盖区语义所要求的。它也不拦源与目标是同一份文档。
    const copied = await target.copyPages(
      this.pdf,
      order.map((pageNumber) => pageNumber - 1),
    );
    for (const page of copied) target.addPage(page);
    // 度量继续用源档那一份：`copyPages` 保留 MediaBox（这条不由注释说了算，
    // 由 `pdf-document.test.ts` 里"排完再存再装载，逐页宽高仍是源档的量得"那条用例钉住）。
    return new PdfEditDocument(
      target,
      this.sourceMetrics,
      order.map((pageNumber) => pageNumber),
    );
  }

  /**
   * 把换算好的覆盖区追加到各自那一页上（spec 3.5-02 的「叠加」半边 + 3.5-06 的中文半边）。
   *
   * 只有这一处碰 `pdf-lib` 的绘制 API，因为它决定三件必须写死的事：
   * ① 垫底矩形必须 `borderWidth: 0`——实测（本机 `pdf-lib` 1.17.1 的 `PDFPageOptions.d.ts`）
   *    `drawRectangle` 的默认描边宽是 1 pt，留着它就成了一圈黑框，而覆盖区的作用是垫一块干净的底；
   *    颜色不写死纯白：那是「能明显看到底部文字」的头一个来源（spec 3.5-14），一律走 `colorsOfOverlay` 的判据；
   * ② 字体按**整条文字**选，不按字符拆：全拉丁走 `StandardFonts.Helvetica`（零内嵌成本，plan §7.2 结论③），
   *    掺一个非拉丁字符就整条走随包的 `Noto Sans SC`——混排（「2024 年经验」）拆成两只字体分段画会让基线与
   *    间距各算一遍，而这只字体本来就带拉丁字形；
   * ③ **两处实测更正**（都来自读三方库的 `.d.ts`，§6.2）：`drawText` 的 `font` 只收 `PDFFont` 不收枚举，
   *    所以标准字体也要 `embedFont` 一次拿句柄（各嵌一次，多一次都不许）；`EmbedFontOptions` 只有
   *    `subset` / `customName` / `features` 三个键，plan §7.2 凭 spike 记忆写的 `custom: true` **并不存在**——
   *    嵌自定义字体靠的是先 `registerFontkit`，而 `subset: true` 是硬要求（spike 第一轮：不子集化产物涨到 31 MB）。
   * @param plans `planOverlays` 通过校验并换算好的覆盖区（PDF 坐标，页号是**源页号**，从 1 起）
   * @param cjkFontBytes 随包字体（woff2）字节，只在真有非拉丁叠加时才用得到；缺它又真要画中文就抛错，**不产豆腐块文件**
   * @throws 页号在本文档里没有任何落点、要画中文却没拿到字体字节、以及 `pdf-lib` 自己的绘制异常（均为普通 `Error`），
   *         连同服务层一起收敛成 `PDF_EDIT_SAVE_FAILED`，**不落半成品**
   */
  async applyOverlays(plans: readonly PlannedOverlay[], cjkFontBytes?: Uint8Array): Promise<void> {
    const pages = this.pdf.getPages();
    const texts = plans.flatMap((plan) => (plan.text === undefined ? [] : [plan.text]));
    const latinFont = texts.some((text) => isLatinOnly(text))
      ? await this.pdf.embedFont(StandardFonts.Helvetica)
      : undefined;
    const cjkFont = texts.some((text) => !isLatinOnly(text)) ? await this.embedCjkFont(cjkFontBytes) : undefined;
    for (const plan of plans) {
      // 一个来源页对应产物里的所有位置：排过页（3.5-07）之后同一源可能有副本，
      // 只盖第一处就等于"改了一份、另一份还露着那段旧话"（plan §7.6 的反伪装精神）。
      const targets = this.pageSources
        .map((source, position) => (source === plan.pageNumber ? position : -1))
        .filter((position) => position >= 0);
      // 越界一律抛，不许静默跳过：跳过等于产出一份「看似改过实则少画几区」的文件（3.5-05 转移来的那条精神）。
      if (targets.length === 0)
        throw new Error(`覆盖区 ${plan.id} 指向源档第 ${String(plan.pageNumber)} 页，本文档的页序里没有来自它的页`);
      for (const position of targets) {
        const page = pages[position];
        if (page === undefined)
          throw new Error(
            `覆盖区 ${plan.id} 落到产物第 ${String(position + 1)} 页，本档只有 ${String(pages.length)} 页`,
          );
        // 底色取渲染层量到的那块纸色，量不到才按墨色垫底（spec 3.5-14）。判据与画布那一条腿共用
        // `colorsOfOverlay`，所以屏幕上看到什么，产物里就是什么。
        const colors = colorsOfOverlay(plan);
        page.drawRectangle({
          x: plan.xPt,
          y: plan.yBottomPt,
          width: plan.widthPt,
          height: plan.heightPt,
          color: rgb(...colors.fillRgb01),
          borderWidth: 0,
        });
        if (plan.text !== undefined && plan.textBaselinePt !== undefined) {
          const font = isLatinOnly(plan.text) ? latinFont : cjkFont;
          if (font !== undefined) {
            page.drawText(plan.text, {
              x: plan.xPt,
              y: plan.textBaselinePt,
              size: plan.sizePt,
              font,
              color: rgb(...colors.inkRgb01),
            });
          }
        }
      }
    }
  }

  /**
   * 嵌入随包的那份中文字体并**子集化**（spec 3.5-06：中文要能嵌进去、可复制可搜索，而不是画成图片）。
   * @param bytes `resources/fonts/noto-sans-sc-chinese-simplified-400-normal.woff2` 的字节
   * @returns 可交给 `drawText` 的字体句柄
   * @throws 没拿到字节时抛普通 `Error`：那是调用方没把随包字体目录读到，绝不能退化成 tofu 文件
   */
  private async embedCjkFont(bytes?: Uint8Array): Promise<PDFFont> {
    if (bytes === undefined) throw new Error('这条叠加含非拉丁字符，但没有拿到随包字体字节');
    // 实测（spike 第二轮 + 本机 1.17.1 的 d.ts）：woff2 也吃得下（原以为只支持 TTF/OTF），
    // 但 `subset: true` 关掉就是 44～557 倍膨胀，所以这里不给调用方关它的口子。
    this.pdf.registerFontkit(fontkit);
    return this.pdf.embedFont(bytes, { subset: true });
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
