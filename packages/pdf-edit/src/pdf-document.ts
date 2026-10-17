/**
 * 既有 PDF 的装载与另存（spec 3.4-03：`pdf-lib` 装载并生成合法 PDF；plan §7.3 的 `pdf-edit` 引擎通道）。
 *
 * 契约与生成轨**相反**，所以它是独立的一只包：`resume-doc` 的真相源是文档模型、PDF 是它的投影；
 * 这里的真相源是**用户手里那份文件**，没有模型可依赖（plan §7.3 的第一条理由）。
 * 降级裁定（2026-10-05）之后这是编辑轨唯一一条引擎通道：纯 JS、随 `app.asar` 内嵌、零 WASM、零原生编译，
 * 因此 `scripts/check-dependency-floor.ts` 的搬运层与 `scripts/check-licenses.ts` 都按现成的口判它（plan §7.7）。
 *
 * 反伪装约束（plan §7.6）：本层只**追加**内容，不改写原内容流——实测覆盖上去的白底矩形之下，
 * 旧文字仍可被提取。于是「旧文字已删除」这类说法在本包的任何返回字段与错误文案里都不许出现。
 */
import { sha256Hex } from '@auto-cc/core/file-read';
import fontkit from '@pdf-lib/fontkit';
import { degrees, PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import { colorsOfOverlay } from './overlay-colors.js';
import { isLatinOnly, type PlannedOverlay } from './overlay-writer.js';
import {
  displayedSize,
  placeVisualPointRatio,
  placeVisualRect,
  NOTE_TEXT_SIZE_PT,
  type PageGeometry,
  type PdfPageRotation,
  type PlannedEditorObject,
  type PlannedEditorPage,
} from './object-model.js';
import { isIdentityOrder } from './page-ops.js';
import type { FontFamilyHint } from './text-metrics.js';

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
    // 哈希在进入三方库之前算：与 4.1 的导入通道同一条顺序约束，字节被消费之后再摘要就是空壳。
    const sourceHash = sha256Hex(bytes);
    try {
      // 交给三方库前先复制一份（同 `source.ts` 的抽取通道）：解析失败或内部缓冲移交都不该动到调用方手里的原件。
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
   * ② 字体按**整条文字**选，不按字符拆：全拉丁的叠加走 `StandardFonts` 里与之对应的那一只（零内嵌成本，
   *    plan §7.2 结论③），字族由渲染层量来的 `fontFamilyHint` 决定（衬线→Times、等宽→Courier、其余→Helvetica，
   *    见 `latinStandardFontOf`）；掺一个非拉丁字符就整条走随包的 `Noto Sans SC`——混排（「2024 年经验」）
   *    拆成两只字体分段画会让基线与间距各算一遍，而这只字体本来就带拉丁字形；
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
    const latinPlans = plans.filter((plan) => plan.text !== undefined && isLatinOnly(plan.text));
    const needsCjk = plans.some((plan) => plan.text !== undefined && !isLatinOnly(plan.text));
    // 拉丁侧按**量到的字族**各嵌一次（spec 3.5-15）：同一份产物里最多三只标准字体，
    // 嵌一只画三种是"字族对不上"的另一半来源；一只都不许多嵌（每只都是一条字体对象）。
    const latinFonts = new Map<FontFamilyHint, PDFFont>();
    for (const plan of latinPlans) {
      const hint = plan.fontFamilyHint ?? 'sans-serif';
      if (latinFonts.has(hint)) continue;
      latinFonts.set(hint, await this.pdf.embedFont(latinStandardFontOf(hint)));
    }
    const cjkFont = needsCjk ? await this.embedCjkFont(cjkFontBytes) : undefined;
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
        // 底色取渲染层量到的那块纸色，量不到才按墨色垫底（spec 3.5-14）。判据与画布那一条通道共用
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
          const font = isLatinOnly(plan.text)
            ? latinFonts.get(plan.fontFamilyHint ?? 'sans-serif')
            : // 中文侧只随包一只 Noto Sans SC（衬线中文要另算字体资产那笔账，见 plan §7.2 结论③）：
              // 所以字族提示在这一支**不兑现**，界面上也不许诺"中文换衬线"。
              cjkFont;
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
   * 按 WPS 形态编辑器的 draft（页计划 + 五类纸面对象）装出一份新文档。
   *
   * 与旧的 `arrange + applyOverlays` 的差别：
   * - 页是带 id 的**计划条目**：源页副本（可重复）或空白页，每条可挂显示旋转；对象绑条目 id；
   * - 对象有 text（改字/文本框）、image、shape、highlight、note 五种，矩形是相对**显示面**的比例坐标；
   * - 源页可带 /Rotate，我们的绘制按最终显示角**反向旋转**落位（`placeVisualRect`），
   *   阅读器把页面转正之后，对象正好落在用户拖出来的那个位置。
   *
   * 仍然是只**追加**内容：就地改字是盖底 + 同基线重绘，旧文字在文本层还在（反伪装约束见头注）。
   * @param pages 已由 `planEditorPages` 校验规整的页计划
   * @param objects 已由 `planEditorObjects` 校验规整的对象
   * @param imageAssets 图片对象 id → 已读出并嗅探过格式的字节（服务层有界读取，本层不碰文件系统）
   * @param cjkFontBytes 有非拉丁文字时必给的随包中文字体字节
   * @returns 装成的新文档（源文件字节一个没动）
   */
  async assembleEditor(
    pages: readonly PlannedEditorPage[],
    objects: readonly PlannedEditorObject[],
    imageAssets?: ReadonlyMap<string, EditorImageAsset>,
    cjkFontBytes?: Uint8Array,
  ): Promise<PdfEditDocument> {
    const target = await PDFDocument.create();

    // ① 按计划顺序装页：源页用 copyPages（重复页号=副本，pdf-lib 不拦重复指标），空白页直接 addPage。
    const sourceIndices = pages
      .filter((page): page is PlannedEditorPage & { sourcePageNumber: number } => page.kind === 'source')
      .map((page) => page.sourcePageNumber - 1);
    const copiedSourcePages = sourceIndices.length > 0 ? await target.copyPages(this.pdf, sourceIndices) : [];
    let copiedCursor = 0;
    /** 每条 id → 装好的页 + 最终几何（原生 MediaBox 宽高 + 最终显示旋转）。 */
    const slots = new Map<string, { page: PDFPage; geometry: PageGeometry }>();
    const outputMetrics: PdfPageMetric[] = [];
    const outputSources: number[] = [];
    for (const entry of pages) {
      if (entry.kind === 'source') {
        const page = copiedSourcePages[copiedCursor++];
        if (page === undefined) throw new Error(`页条目 ${entry.id} 的源页拷贝缺失（copyPages 少给了页）`);
        // 旋转缺省＝保留源档原有的 /Rotate（显式给 0 才是"转正"）。
        const existing = reduceRotationToQuarter(page.getRotation().angle);
        const rotation = entry.rotation ?? existing;
        if (page.getRotation().angle !== rotation) page.setRotation(degrees(rotation));
        target.addPage(page);
        slots.set(entry.id, {
          page,
          geometry: { widthPt: page.getWidth(), heightPt: page.getHeight(), rotation },
        });
        outputMetrics.push({ number: outputMetrics.length + 1, widthPt: page.getWidth(), heightPt: page.getHeight() });
        outputSources.push(entry.sourcePageNumber ?? 0);
      } else {
        const page = target.addPage([entry.widthPt, entry.heightPt]);
        const rotation = entry.rotation ?? 0;
        if (rotation !== 0) page.setRotation(degrees(rotation));
        slots.set(entry.id, { page, geometry: { widthPt: entry.widthPt, heightPt: entry.heightPt, rotation } });
        outputMetrics.push({ number: outputMetrics.length + 1, widthPt: entry.widthPt, heightPt: entry.heightPt });
        outputSources.push(0);
      }
    }

    // ② 字体：拉丁按 字族×粗斜 各嵌一只标准字体；任何非拉丁文字出现就嵌随包 Noto Sans SC（粗斜不兑现）。
    const needsCjk = objects.some(
      (object) =>
        (object.kind === 'text' || object.kind === 'note') && object.text !== undefined && !isLatinOnly(object.text),
    );
    const latinFonts = new Map<string, PDFFont>();
    const cjkFont = needsCjk ? await this.embedCjkFontOn(target, cjkFontBytes) : undefined;
    /** 取一个文本对象该用的字体句柄（同键只嵌一次）。 */
    const fontFor = async (object: PlannedEditorObject): Promise<PDFFont> => {
      if (object.text !== undefined && !isLatinOnly(object.text)) {
        if (cjkFont === undefined) throw new Error(`对象 ${object.id} 含非拉丁字符，但没有拿到随包字体字节`);
        return cjkFont;
      }
      const key = `${object.fontFamilyHint ?? 'sans-serif'}/${object.bold ? 'b' : ''}${object.italic ? 'i' : ''}`;
      const cached = latinFonts.get(key);
      if (cached !== undefined) return cached;
      const font = target.embedFont(latinStandardFontOfStyle(object.fontFamilyHint, object.bold, object.italic));
      // embedFont 对标准字体是同步返回（pdf-lib 1.17.1 类型上写 PromiseLike，实测 await 也安全）。
      const handle = isThenable(font) ? await font : font;
      latinFonts.set(key, handle);
      return handle;
    };

    // ③ 图片按路径去重嵌入（同一图被多个对象引用时只嵌一份资源）。
    const embeddedImages = new Map<string, { image: Awaited<ReturnType<PDFDocument['embedPng']>> }>();
    const imageFor = async (object: PlannedEditorObject) => {
      const asset = imageAssets?.get(object.id);
      if (asset === undefined) throw new Error(`图片对象 ${object.id} 没有拿到图片字节`);
      const cacheKey = `${asset.format}:${asset.bytes.length}`;
      const cached = embeddedImages.get(object.imagePath ?? cacheKey);
      if (cached !== undefined) return cached.image;
      const embedded = asset.format === 'png' ? await target.embedPng(asset.bytes) : await target.embedJpg(asset.bytes);
      embeddedImages.set(object.imagePath ?? cacheKey, { image: embedded });
      return embedded;
    };

    // ④ 逐对象绘制（顺序即对象数组顺序，后画的压先画的）。
    for (const object of objects) {
      const slot = slots.get(object.pageId);
      if (slot === undefined) throw new Error(`对象 ${object.id} 绑的页 ${object.pageId} 不在装成的文档里`);
      const { page, geometry } = slot;
      if (object.kind === 'text') {
        await this.drawEditorText(page, geometry, object, fontFor);
      } else if (object.kind === 'note') {
        await this.drawEditorNote(page, geometry, object, fontFor);
      } else if (object.kind === 'highlight') {
        const placement = placeVisualRect(object.rect, geometry);
        page.drawRectangle({
          x: placement.xPt,
          y: placement.yPt,
          width: placement.widthPt,
          height: placement.heightPt,
          rotate: degrees(-placement.drawRotationDegrees),
          color: rgb(...hexRgb01(object.colorHex ?? HIGHLIGHT_HEX)),
          opacity: HIGHLIGHT_OPACITY,
          borderWidth: 0,
        });
      } else if (object.kind === 'shape') {
        const placement = placeVisualRect(object.rect, geometry);
        page.drawRectangle({
          x: placement.xPt,
          y: placement.yPt,
          width: placement.widthPt,
          height: placement.heightPt,
          rotate: degrees(-placement.drawRotationDegrees),
          ...(object.fillHex === undefined ? {} : { color: rgb(...hexRgb01(object.fillHex)) }),
          borderColor: rgb(...hexRgb01(object.colorHex ?? SHAPE_BORDER_HEX)),
          borderWidth: object.borderWidthPt ?? 1.5,
        });
      } else {
        const placement = placeVisualRect(object.rect, geometry);
        const image = await imageFor(object);
        page.drawImage(image, {
          x: placement.xPt,
          y: placement.yPt,
          width: placement.widthPt,
          height: placement.heightPt,
          rotate: degrees(-placement.drawRotationDegrees),
        });
      }
    }

    return new PdfEditDocument(target, outputMetrics, outputSources);
  }

  /**
   * 画一个文本对象：有 `backdropHex` 先垫纸色（就地改字），再按基线落字，最后按需画下划线。
   */
  private async drawEditorText(
    page: PDFPage,
    geometry: PageGeometry,
    object: PlannedEditorObject,
    fontFor: (object: PlannedEditorObject) => PDFFont | Promise<PDFFont>,
  ): Promise<void> {
    const text = object.text;
    const sizePt = object.sizePt;
    if (text === undefined || sizePt === undefined) return;
    const font = await fontFor(object);
    const display = displayedSize(geometry);

    // 就地改字的垫底矩形：颜色走 colorsOfOverlay 那同一份判据（量不到纸色就墨底反白，绝不猜白）。
    let inkHex = object.colorHex ?? DEFAULT_INK_HEX;
    if (object.backdropHex !== undefined) {
      const colors = colorsOfOverlay(object);
      const cover = placeVisualRect(object.rect, geometry);
      page.drawRectangle({
        x: cover.xPt,
        y: cover.yPt,
        width: cover.widthPt,
        height: cover.heightPt,
        rotate: degrees(-cover.drawRotationDegrees),
        color: rgb(...colors.fillRgb01),
        borderWidth: 0,
      });
      // 没显式给墨色时，垫底用什么回落（纸色 or 墨底），字就跟着那一份判据走反白/深墨。
      if (object.colorHex === undefined) inkHex = colors.inkHex;
    }

    // 基线：量到的页面比例优先；没量到按 em 盒竖向居中（与旧 overlay 的 baselinePt 同一式）。
    const baselineYRatio =
      object.baselineYRatio ?? object.rect.yRatio + object.rect.heightRatio / 2 + sizePt / (2 * display.heightPt);
    const anchor = placeVisualPointRatio(object.rect.xRatio, baselineYRatio, geometry);
    page.drawText(text, {
      x: anchor.xPt,
      y: anchor.yPt,
      rotate: degrees(-anchor.drawRotationDegrees),
      size: sizePt,
      font,
      color: rgb(...hexRgb01(inkHex)),
    });
    if (object.underline) {
      const textWidthPt = font.widthOfTextAtSize(text, sizePt);
      const underlineRect = {
        xRatio: object.rect.xRatio,
        yRatio: baselineYRatio + (sizePt * 0.1) / display.heightPt,
        widthRatio: textWidthPt / display.widthPt,
        heightRatio: (sizePt * 0.06) / display.heightPt,
      };
      const line = placeVisualRect(underlineRect, geometry);
      page.drawRectangle({
        x: line.xPt,
        y: line.yPt,
        width: line.widthPt,
        height: line.heightPt,
        rotate: degrees(-line.drawRotationDegrees),
        color: rgb(...hexRgb01(inkHex)),
        borderWidth: 0,
      });
    }
  }

  /**
   * 画一张便签：黄色贴纸 + 边框 + 自动换行的小字。换行按**字符贪心**（中日韩没有词边界），
   * 量宽用字体自己的 `widthOfTextAtSize`（随包字体注册过 fontkit，量得准），超出盒子的行数裁掉并加省略号。
   */
  private async drawEditorNote(
    page: PDFPage,
    geometry: PageGeometry,
    object: PlannedEditorObject,
    fontFor: (object: PlannedEditorObject) => PDFFont | Promise<PDFFont>,
  ): Promise<void> {
    const sizePt = NOTE_TEXT_SIZE_PT;
    const font = await fontFor(object);
    const display = displayedSize(geometry);
    const bg = placeVisualRect(object.rect, geometry);
    page.drawRectangle({
      x: bg.xPt,
      y: bg.yPt,
      width: bg.widthPt,
      height: bg.heightPt,
      rotate: degrees(-bg.drawRotationDegrees),
      color: rgb(...hexRgb01(NOTE_FILL_HEX)),
      borderColor: rgb(...hexRgb01(NOTE_BORDER_HEX)),
      borderWidth: 1,
    });
    if (object.text === undefined || object.text === '') return;

    const padPt = 4;
    const lineHeightPt = sizePt * 1.3;
    const boxWidthPt = object.rect.widthRatio * display.widthPt;
    const boxHeightPt = object.rect.heightRatio * display.heightPt;
    const availableWidth = boxWidthPt - padPt * 2;
    const maxLines = Math.max(1, Math.floor((boxHeightPt - padPt * 2) / lineHeightPt));
    const lines = wrapTextToLines(object.text, font, sizePt, availableWidth, maxLines);
    for (let index = 0; index < lines.length; index += 1) {
      // 显示面 y 向下：第 i 行基线距盒顶 pad + 0.8 个字高，每行再往下走一行高。
      const yRatio = object.rect.yRatio + (padPt + sizePt * 0.8 + index * lineHeightPt) / display.heightPt;
      const xRatio = object.rect.xRatio + padPt / display.widthPt;
      const anchor = placeVisualPointRatio(xRatio, yRatio, geometry);
      page.drawText(lines[index] as string, {
        x: anchor.xPt,
        y: anchor.yPt,
        rotate: degrees(-anchor.drawRotationDegrees),
        size: sizePt,
        font,
        color: rgb(...hexRgb01(object.colorHex ?? NOTE_INK_HEX)),
      });
    }
  }

  /** 在指定目标文档上嵌随包中文字体（assembleEditor 用的是新 target，不是装载那份 this.pdf）。 */
  private async embedCjkFontOn(target: PDFDocument, bytes?: Uint8Array): Promise<PDFFont> {
    if (bytes === undefined) throw new Error('这份产物含非拉丁字符，但没有拿到随包字体字节');
    target.registerFontkit(fontkit);
    return target.embedFont(bytes, { subset: true });
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

/** 图片资源：服务层按对象 id 读出、嗅探过格式的字节。 */
export interface EditorImageAsset {
  readonly format: 'png' | 'jpeg';
  readonly bytes: Uint8Array;
}

/** 新文本对象没给墨色时的默认深墨（与 overlay-colors 的 DEFAULT_INK 同档）。 */
const DEFAULT_INK_HEX = '#0f172a';
/** 高亮默认荧光黄（半透明叠在原文上仍读得清字）。 */
const HIGHLIGHT_HEX = '#ffe066';
const HIGHLIGHT_OPACITY = 0.35;
/** 形状默认描边色（WPS 批注矩形那档红）。 */
const SHAPE_BORDER_HEX = '#dc2626';
/** 便签贴纸配色。 */
const NOTE_FILL_HEX = '#fff2a8';
const NOTE_BORDER_HEX = '#ca8a04';
const NOTE_INK_HEX = '#1f2937';

/** 归一化后的 `#rrggbb` → 0..1 三元组（入参都来自 planEditorObjects 的 normalizeHexColor 或上面的常量）。 */
function hexRgb01(hex: string): readonly [number, number, number] {
  const body = hex.slice(1);
  return [
    Number.parseInt(body.slice(0, 2), 16) / 255,
    Number.parseInt(body.slice(2, 4), 16) / 255,
    Number.parseInt(body.slice(4, 6), 16) / 255,
  ];
}

/** 任意值是不是 PromiseLike（pdf-lib 的 embedFont 重载在类型上两者都可能）。 */
function isThenable<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return typeof (value as PromiseLike<T>)?.then === 'function';
}

/** pdf-lib 读出的旋转角可能带 360/负数，收成 0/90/180/270。 */
function reduceRotationToQuarter(angle: number): PdfPageRotation {
  const normalized = ((Math.round(angle) % 360) + 360) % 360;
  if (normalized === 90 || normalized === 180 || normalized === 270) return normalized;
  return 0;
}

/**
 * 拉丁文字体按 字族×粗斜 取标准字体（每种组合都是 PDF 内置字体，零内嵌成本）。
 * 中文侧只有一只 Noto Sans SC，粗斜不兑现——界面不许诺"中文加粗"。
 */
function latinStandardFontOfStyle(hint: FontFamilyHint | undefined, bold: boolean, italic: boolean): StandardFonts {
  switch (hint) {
    case 'serif':
      if (bold && italic) return StandardFonts.TimesRomanBoldItalic;
      if (bold) return StandardFonts.TimesRomanBold;
      if (italic) return StandardFonts.TimesRomanItalic;
      return StandardFonts.TimesRoman;
    case 'monospace':
      if (bold && italic) return StandardFonts.CourierBoldOblique;
      if (bold) return StandardFonts.CourierBold;
      if (italic) return StandardFonts.CourierOblique;
      return StandardFonts.Courier;
    default:
      if (bold && italic) return StandardFonts.HelveticaBoldOblique;
      if (bold) return StandardFonts.HelveticaBold;
      if (italic) return StandardFonts.HelveticaOblique;
      return StandardFonts.Helvetica;
  }
}

/**
 * 按可用宽度贪心折行（逐字符，兼顾中日韩无空格与拉丁词）。
 * @param maxLines 最多返回的行数；超限在最后一行尾部加省略号
 */
function wrapTextToLines(
  text: string,
  font: PDFFont,
  sizePt: number,
  availableWidthPt: number,
  maxLines: number,
): string[] {
  const lines: string[] = [];
  let current = '';
  const pushCurrent = () => {
    lines.push(current);
    current = '';
  };
  for (const character of text) {
    if (character === '\n') {
      pushCurrent();
      if (lines.length >= maxLines) break;
      continue;
    }
    const candidate = current + character;
    if (font.widthOfTextAtSize(candidate, sizePt) <= availableWidthPt || current === '') {
      current = candidate;
    } else {
      pushCurrent();
      if (lines.length >= maxLines) break;
      current = character;
    }
  }
  if (current !== '' && lines.length < maxLines) lines.push(current);

  // 还有字没放进去：最后一行能塞下省略号就补上（塞不下直接替换尾字符）。
  const consumed = lines.join('').length;
  if (consumed < text.length && lines.length > 0) {
    let last = lines[lines.length - 1] as string;
    const ellipsis = '…';
    while (last.length > 0 && font.widthOfTextAtSize(last + ellipsis, sizePt) > availableWidthPt) {
      last = last.slice(0, -1);
    }
    lines[lines.length - 1] = last + ellipsis;
  }
  return lines;
}

/**
 * 把量来的字族提示换成**这一版真能兑现**的那只标准字体（spec 3.5-15）。
 *
 * 为什么只此三种：本片刻意不引入字体资产（plan §7.2 结论③ 那笔账），而 `StandardFonts` 里
 * 与三种通用字族对得上的就是 Times / Courier / Helvetica 这三支。源文档用的是 Calibri 时，
 * 产物里是 Times 而不是 Calibri——**这是如实的欠项，不是"对上了"**，界面上那句"按原样式"要等族三才说得出。
 * @param hint 渲染层量来的字族（`undefined` 由调用方先补成 `'sans-serif'`）
 * @returns 交给 `embedFont` 的枚举
 */
export function latinStandardFontOf(hint: FontFamilyHint): StandardFonts {
  switch (hint) {
    case 'serif':
      return StandardFonts.TimesRoman;
    case 'monospace':
      return StandardFonts.Courier;
    case 'sans-serif':
      return StandardFonts.Helvetica;
  }
}
