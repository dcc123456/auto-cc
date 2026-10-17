/**
 * `pdf.export` 服务（plan §7.4 的另存通道；spec 3.5-02 / 3.5-09，并接住从 3.4-04/05/07 转移来的确定态）。
 *
 * 一句话：**源文件只读，产物是新文件**。整条链上唯一一次写盘发生在最后那一下 `rename`，
 * 且写的是 `<outPath>.part` 再改名（plan §7.10）——于是「抛错的时候磁盘上没有半成品」是结构上的必然，
 * 而不是一句承诺。这正是 3.5-05 那条「绝不产出看似改过实则含原文的文件」在降级路线下的替身。
 *
 * 为什么入参还是路径而不是「把 `pdf.io` 打开的那份文档递过来」：主进程不在两次调用之间存活的会话态
 * （plan §7.1 的存储行——覆盖区列表活在渲染层的 draft 里）。所以每次另存重新读一遍源文件，
 * 顺带把「源文件在此期间被人动过」这件事也读进来了。
 */
import { isAbsolute, join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rename, rm, writeFile } from 'node:fs/promises';
import { AppError, maybeService, Service, type Context } from '@auto-cc/core';
import { readBoundedFile, sha256Hex } from '@auto-cc/core/file-read';
import { z } from 'zod';
import {
  type EditorImageAsset,
  PdfEditDocument,
} from './pdf-document.js';
import {
  DEFAULT_BLANK_HEIGHT_PT,
  DEFAULT_BLANK_WIDTH_PT,
  planEditorObjects,
  planEditorPages,
  sniffImageMagic,
  type EditorObjectRejection,
  type EditorPageRejection,
  type PdfEditorObjectInput,
  type PdfEditorPageInput,
} from './object-model.js';
import {
  isLatinOnly,
  planOverlays,
  type OverlayRejection,
  type PdfOverlayInput,
} from './overlay-writer.js';
import { planPageOrder, type PageOrderRejection } from './page-ops.js';

/**
 * 随包中文字体的文件名（与生成轨打印用的是**同一份资产**，plan §7.1 的字体资产行）。
 * 目录由 L1 的 `resume.print.fontBaseUrl()` 给（开发态仓库 `resources/fonts`、打包态 `process.resourcesPath/fonts`），
 * 本层不猜第二份路径——同一件事在 `resume-doc` 的导出通道已经是这个形状（§2.2）。
 */
const CJK_FONT_FILE = 'noto-sans-sc-chinese-simplified-400-normal.woff2';

/** `pdf.export` 的可调项：一条尺度一个键，代码内不留魔法数。 */
export const pdfExportSchema = z.strictObject({
  /** 与 `pdf.io` 同一量级的读取上限（见 `pdfIoSchema` 的理由）。 */
  maxBytes: z.number().int().min(1024).max(52_428_800).default(5_242_880),
  /** 单次另存允许的覆盖区条数：超出即拒，不做「画到第 N 区为止」这种半成品。 */
  maxOverlays: z.number().int().min(1).max(200).default(50),
  /** 产物允许的页数上限：页序是渲染层给的外部输入，不设界等于让它用一只数组把主进程的内存顶满。 */
  maxPages: z.number().int().min(1).max(500).default(64),
  /** 覆盖区没自带字号时的默认字号（pt）。 */
  defaultTextSizePt: z.number().min(1).max(96).default(11),
  /** 覆盖区的最小面积（比例）：细到看不见的框多半是拖拽出错，拒掉比画上去好。 */
  minAreaRatio: z.number().min(0).max(1).default(0.0001),
  /** WPS 形态编辑器单次另存允许的纸面对象条数。 */
  maxObjects: z.number().int().min(1).max(500).default(100),
  /** 单张插图的字节上限（渲染层预览与另存两侧共用同一档，不许长出两个数）。 */
  maxImageBytes: z.number().int().min(1024).max(31_457_280).default(10_485_760),
});

export type PdfExportConfig = z.output<typeof pdfExportSchema>;

/** `saveAs` 的回执：产物路径 + 产物指纹 + 页数（界面据此提示"存好了"，见 plan §7.4）。 */
export interface PdfSaveAsReceipt {
  readonly outPath: string;
  /** 产物字节的 sha256。注意它**不等于**源文件哈希——源文件从头到尾没被写过（3.5-09）。 */
  readonly sha256: string;
  readonly pageCount: number;
}

/**
 * 另存通道的失败子原因（进 `AppError.details.code`）。
 * 覆盖区校验那几种复用 `OverlayRejection['code']` 的字面量，不另起一套说法。
 */
type SaveFailureCode =
  | 'out-path-not-absolute'
  | 'out-is-source'
  | OverlayRejection['code']
  | PageOrderRejection['code']
  | EditorPageRejection['code']
  | EditorObjectRejection['code']
  | 'invalid-pdf'
  | 'encrypted'
  | 'empty'
  | 'font-unavailable'
  | 'image-unreadable'
  | 'image-format'
  | 'draw-failed'
  | 'write-failed';

/**
 * 把覆盖区追加到既有 PDF 上并存成新文件。
 */
export class PdfExportService extends Service {
  static provide = 'pdf.export';
  static Config = pdfExportSchema;

  constructor(
    ctx: Context,
    private readonly options: PdfExportConfig,
  ) {
    super(ctx, 'pdf.export');
  }

  [Service.init](): void {
    this.ctx.logger.info(
      `[pdf-edit] pdf.export 就绪，单次上限 ${String(this.options.maxOverlays)} 个覆盖区、默认字号 ${String(this.options.defaultTextSizePt)} pt（中文叠加经随包字体子集内嵌）`,
    );
  }

  /**
   * 随包中文字体的字节，**只在真要画非拉丁文字时**才读。
   * @param texts 所有要画上纸面的文字（覆盖区或编辑器对象，调用方各自筛好递进来）
   * @returns 有非拉丁字要画时给 woff2 字节；纯拉丁给 `undefined`（零内嵌成本，plan §7.2 结论③）
   * @throws `AppError('PDF_EDIT_SAVE_FAILED')`（`font-unavailable`）——字体目录读不到时如实失败，绝不退化成豆腐块
   */
  private cjkFontBytes(
    texts: readonly string[],
    outPath: string,
    origin: 'pdf.export.saveAs' | 'pdf.export.saveEditor' = 'pdf.export.saveAs',
  ): Uint8Array | undefined {
    if (!texts.some((text) => !isLatinOnly(text))) return undefined;
    // 按名字现问（§9 的 2.5 那条：热改配置会重建下游，本地不该存第二份事实），询问面窄到只用得上一个读数。
    // 按名字现问（§9 的 2.5 那条：热改配置会重建下游，本地不该存第二份事实）。询问面在这里只写成一个读数：
    // `pdf-edit` 不依赖 `@auto-cc/shared`（plan §7.3 的依赖行），而 L1 那个端口结构上满足它就够了。
    const printPort = maybeService<{ fontBaseUrl(): string }>(this.ctx, 'resume.print');
    if (printPort === undefined)
      throw this.failure('font-unavailable', `这份中文叠加画不出来：随包字体目录问不到（${CJK_FONT_FILE}）`, outPath, undefined, origin);
    const fontDir = fileURLToPath(printPort.fontBaseUrl());
    try {
      // 1.1 MB 的随包资产，不走 `readBoundedFile`：那套上限是给**用户手里的文件**设的，随包字体是我们自己的东西。
      return readFileSync(join(fontDir, CJK_FONT_FILE));
    } catch (error) {
      throw this.failure(
        'font-unavailable',
        `这份中文叠加画不出来：随包字体没找到（${join(fontDir, CJK_FONT_FILE)}）`,
        outPath,
        error instanceof Error ? error.message : String(error),
        origin,
      );
    }
  }

  /**
   * 另存一份带覆盖区与页序的 PDF。
   * @param filePath 源文件的**绝对路径**（只读，本方法不打开它第二回、不写它一个字节）
   * @param overlays 渲染层 draft 里的覆盖区（不可信输入：越界、超量、非拉丁文字都在这里被挡下）
   * @param pageOrder 产物的逐页来源页号（1 起；重复＝增页、缺项＝删页、换序＝重排，见 `page-ops.ts`）。
   *                  不许给空数组：空数组既读成"删光"又读成"没想重排"，两种意思都拒（不重排请显式给 `[1…n]`）。
   * @param outPath 产物路径（**绝对**，且不许等于源文件）
   * @returns 产物路径、产物 sha256 与**产物**页数
   * @throws `AppError('PDF_EDIT_SAVE_FAILED')`——上述任何一种失败；抛出时磁盘上没有 `<outPath>` 也没有 `<outPath>.part`
   */
  async saveAs(
    filePath: string,
    overlays: readonly PdfOverlayInput[],
    pageOrder: readonly number[],
    outPath: string,
  ): Promise<PdfSaveAsReceipt> {
    // 先判"别把产物写到源文件上"，再去读文件：这条是 3.5-09 的第一道闸，代价只是一次字符串比较。
    if (!isAbsolute(outPath))
      throw this.failure('out-path-not-absolute', `产物路径必须是绝对路径：${outPath}`, outPath);
    if (resolve(outPath) === resolve(filePath)) {
      throw this.failure('out-is-source', `产物路径与源文件相同，轻编辑不允许就地改：${filePath}`, outPath);
    }

    const bytes = readBoundedFile(filePath, { maxBytes: this.options.maxBytes, code: 'PDF_EDIT_SAVE_FAILED' });
    const loaded = await PdfEditDocument.load(bytes);
    if (loaded.status === 'failed') {
      throw this.failure(
        loaded.reason === 'invalid' ? 'invalid-pdf' : loaded.reason,
        `这份文件没法拿来另存：${filePath}（${loaded.detail}）`,
        outPath,
        loaded.detail,
      );
    }

    const planned = planOverlays(overlays, loaded.document.sourcePageMetrics(), {
      maxOverlays: this.options.maxOverlays,
      defaultTextSizePt: this.options.defaultTextSizePt,
      minAreaRatio: this.options.minAreaRatio,
    });
    if (!planned.ok) {
      throw this.failure(planned.code, `这些覆盖区没法画上去：${planned.detail}`, outPath, planned.detail);
    }
    // 页序在这里只**判**不改：换算覆盖区要先有源页度量（上面那一句），落盘更要先有完整产物，
    // 所以"校验全在碰磁盘之前"这条顺序（3.5-05 转移来的精神）在这里不能为了省事打乱。
    const order = planPageOrder(pageOrder, loaded.document.sourcePageCount, this.options.maxPages);
    if (!order.ok) {
      throw this.failure(order.code, `这份页序没法用：${order.detail}`, outPath, order.detail);
    }
    // 要画中文就先把随包字体读进来，位置仍然在碰磁盘之前：读不到以 `font-unavailable` 失败，
    // 而不是画成豆腐块（那正是 plan §7.2 结论③ 反对的"看似改过实则不可读"）。
    const cjkFontBytes = this.cjkFontBytes(
      planned.overlays.flatMap((overlay) => (overlay.text === undefined ? [] : [overlay.text])),
      outPath,
    );

    // 排页 + 绘制 + 生成合在一个 try 里：pdf-lib 在 `save()` 时才把内容流拼出来，
    // 任何一步抛错都必须在落盘之前，这样"失败不落半成品"不需要额外的清理逻辑。
    let product: Uint8Array;
    let pageCount: number;
    try {
      const target = await loaded.document.arrange(order.order);
      await target.applyOverlays(planned.overlays, cjkFontBytes);
      pageCount = target.pageCount;
      product = await target.save();
    } catch (error) {
      throw this.failure(
        'draw-failed',
        `生成 PDF 失败，没有写出任何文件：${filePath}`,
        outPath,
        error instanceof Error ? error.message : String(error),
      );
    }

    // 字节全在内存里了才开始碰磁盘；`rename` 是这一步唯一的"可见"动作，之前 `<outPath>` 一直不存在。
    const partPath = `${outPath}.part`;
    try {
      await writeFile(partPath, product);
      await rename(partPath, outPath);
    } catch (error) {
      // `force: true`：`writeFile` 自己失败时 `part` 根本不存在，这里不该因为 ENOENT 再抛一次盖掉真原因。
      await rm(partPath, { force: true });
      throw this.failure(
        'write-failed',
        `没能写到 ${outPath}`,
        filePath,
        error instanceof Error ? error.message : String(error),
      );
    }

    return { outPath, sha256: sha256Hex(product), pageCount };
  }

  /**
   * WPS 形态编辑器的另存通道：页计划（源页副本/空白页/旋转）+ 五类纸面对象 → 一份新 PDF。
   *
   * 源文件只读、只另存新文件（与 `saveAs` 同一道闸、同一种 `.part` → `rename` 落盘）。
   * 图片字节在这里按对象里的路径**主进程侧有界读取**：渲染层预览时已读过一次，字节不随对象过 IPC。
   * @param filePath 源文件绝对路径
   * @param pages 渲染层 draft 的页计划（不可信，越界/重复 id/非法旋转都在这里拒）
   * @param objects 渲染层 draft 的纸面对象（不可信，矩形/字号/文字码位/图片路径都在这里拒）
   * @param outPath 产物绝对路径，不许等于源文件
   * @throws `AppError('PDF_EDIT_SAVE_FAILED')`，`details.code` 给子原因；抛出时磁盘上没有半成品
   */
  async saveEditor(
    filePath: string,
    pages: readonly PdfEditorPageInput[],
    objects: readonly PdfEditorObjectInput[],
    outPath: string,
  ): Promise<PdfSaveAsReceipt> {
    const origin = 'pdf.export.saveEditor';
    if (!isAbsolute(outPath))
      throw this.failure('out-path-not-absolute', `产物路径必须是绝对路径：${outPath}`, outPath, undefined, origin);
    if (resolve(outPath) === resolve(filePath)) {
      throw this.failure('out-is-source', `产物路径与源文件相同，编辑器不允许就地覆盖：${filePath}`, outPath, undefined, origin);
    }

    const bytes = readBoundedFile(filePath, { maxBytes: this.options.maxBytes, code: 'PDF_EDIT_SAVE_FAILED' });
    const loaded = await PdfEditDocument.load(bytes);
    if (loaded.status === 'failed') {
      throw this.failure(
        loaded.reason === 'invalid' ? 'invalid-pdf' : loaded.reason,
        `这份文件没法拿来另存：${filePath}（${loaded.detail}）`,
        outPath,
        loaded.detail,
        origin,
      );
    }

    // 先判页计划再判对象：对象的 pageId 要认规整后的页条目。
    const plannedPages = planEditorPages(pages, loaded.document.sourcePageCount, {
      maxPages: this.options.maxPages,
      defaultBlankWidthPt: DEFAULT_BLANK_WIDTH_PT,
      defaultBlankHeightPt: DEFAULT_BLANK_HEIGHT_PT,
    });
    if (!plannedPages.ok) {
      throw this.failure(plannedPages.code, `这份页计划没法用：${plannedPages.detail}`, outPath, plannedPages.detail, origin);
    }
    const plannedObjects = planEditorObjects(objects, plannedPages.pages, {
      maxObjects: this.options.maxObjects,
      defaultTextSizePt: this.options.defaultTextSizePt,
      minAreaRatio: this.options.minAreaRatio,
    });
    if (!plannedObjects.ok) {
      throw this.failure(plannedObjects.code, `这些对象画不上去：${plannedObjects.detail}`, outPath, plannedObjects.detail, origin);
    }

    // 图片按路径去重读（同一图被多个对象引用时只读一次），格式靠魔数判定而不是扩展名。
    const imageAssets = new Map<string, EditorImageAsset>();
    const imageCache = new Map<string, EditorImageAsset>();
    for (const object of plannedObjects.objects.filter((item) => item.kind === 'image')) {
      const imagePath = object.imagePath;
      if (imagePath === undefined) {
        throw this.failure('image-unreadable', `图片对象 ${object.id} 没有图片路径`, outPath, 'missing imagePath', origin);
      }
      let asset = imageCache.get(imagePath);
      if (asset === undefined) {
        let imageBytes: Uint8Array;
        try {
          imageBytes = readBoundedFile(imagePath, { maxBytes: this.options.maxImageBytes, code: 'PDF_EDIT_SAVE_FAILED' });
        } catch (error) {
          throw this.failure(
            'image-unreadable',
            `图片读不出来或超过 ${String(this.options.maxImageBytes)} 字节上限：${imagePath}`,
            outPath,
            error instanceof Error ? error.message : String(error),
            origin,
          );
        }
        const format = sniffImageMagic(imageBytes);
        if (format === undefined) {
          throw this.failure('image-format', `只支持 PNG 与 JPEG 图片，这份不是：${imagePath}`, outPath, 'bad magic bytes', origin);
        }
        asset = { format, bytes: imageBytes };
        imageCache.set(imagePath, asset);
      }
      imageAssets.set(object.id, asset);
    }

    const cjkFontBytes = this.cjkFontBytes(
      plannedObjects.objects.filter((object) => object.text !== undefined).map((object) => object.text as string),
      outPath,
      origin,
    );

    let product: Uint8Array;
    let pageCount: number;
    try {
      const assembled = await loaded.document.assembleEditor(
        plannedPages.pages,
        plannedObjects.objects,
        imageAssets,
        cjkFontBytes,
      );
      pageCount = assembled.pageCount;
      product = await assembled.save();
    } catch (error) {
      throw this.failure(
        'draw-failed',
        `生成 PDF 失败，没有写出任何文件：${filePath}`,
        outPath,
        error instanceof Error ? error.message : String(error),
        origin,
      );
    }

    const partPath = `${outPath}.part`;
    try {
      await writeFile(partPath, product);
      await rename(partPath, outPath);
    } catch (error) {
      await rm(partPath, { force: true });
      throw this.failure(
        'write-failed',
        `没能写到 ${outPath}`,
        filePath,
        error instanceof Error ? error.message : String(error),
        origin,
      );
    }

    return { outPath, sha256: sha256Hex(product), pageCount };
  }

  /**
   * 构造本服务的失败：一个码 + 一句中文 + 子原因，界面只写一处分支。
   * @param code 子原因（见 `SaveFailureCode`）
   * @param message 可以直接显示给用户的一句话
   * @param outPath 用户要写入的位置（放进 `details`，便于排查"是不是路径给错了"）
   * @param detail 技术原文（只在 `details` 里，不进界面）
   * @param origin 通道名（旧覆盖区走 saveAs，WPS 编辑器走 saveEditor，日志里要分得清）
   * @returns 待抛出的 `AppError`
   */
  private failure(
    code: SaveFailureCode,
    message: string,
    outPath: string,
    detail?: string,
    origin: 'pdf.export.saveAs' | 'pdf.export.saveEditor' = 'pdf.export.saveAs',
  ): AppError {
    return new AppError(
      'PDF_EDIT_SAVE_FAILED',
      message,
      origin,
      detail === undefined ? { code, outPath } : { code, outPath, detail },
    );
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'pdf.export': PdfExportService;
  }
}
