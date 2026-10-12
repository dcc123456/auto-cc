/**
 * 简历源文件 → 纯文本 → 文档模型（spec 4.1-01 的 PDF / DOCX 两条依赖通道，以及 4.1-06 的失败路径）。
 *
 * 职责边界：本文件只做「字节 → 文本」，字段抽取仍然全部交给 `sections.ts`；
 * `parseResumeSource` 是这一层唯一的对外入口，服务层与界面只认它，不允许各调各的抽取函数（AGENTS.md §2.5）。
 * 与 4.1-a 一样，这里不认识 cordis、不认识 SQLite，因此可以离线单测。
 *
 * 依赖与实测口径（取证见 `docs/plans/04-resume-kb/plan.md` §1.1，许可判定见 `docs/research/source-repos-analysis.md`）：
 * - PDF 走 `pdfjs-dist` 的 **legacy 构建**（Apache-2.0，非 AGPL 的 mupdf）。实测 Node 24 主进程内
 *   无需 worker 即可抽文本，但必须带 `isEvalSupported:false` + `disableFontFace:true`；
 *   文本项靠 `hasEOL` 断行——同 y 的两列之间 pdf.js 会自己插一个空格项，所以直接拼 `str` 就是「公司 时间」一行。
 * - DOCX 走 `mammoth`（BSD-2-Clause）的 `extractRawText`，段与段之间给空行，正好落进 `sections.ts` 的块模型。
 * - **不引入 OCR**：图片型 PDF 抽出来就是近零字符，一律由 `MIN_TEXT_CHAR_COUNT` 判成疑似扫描件（4.1-05）。
 */
import { sha256Hex } from '@auto-cc/core/file-read';
import { NESTED_INDENT, type ResumeDocument } from '@auto-cc/plugin-resume-doc';
import { type ParseIssue, parseResumeText } from './sections.js';

/** 导入源格式。`markdown` 与 `text` 只影响界面回显，解析规则完全一致。 */
export type ResumeSourceFormat = 'pdf' | 'docx' | 'markdown' | 'text';

/** 抽取失败的机器码。中文提示由渲染层 i18n 决定，这里只给可机检的枚举与技术原因。 */
export type SourceFailureCode = 'empty' | 'unsupported-format' | 'invalid-pdf' | 'invalid-docx';

/** 抽取成功：判定出的格式 + 拼回行结构后的正文（扫描件会是空串，交由长度闸门判定）。 */
export interface ExtractedSourceText {
  readonly status: 'extracted';
  readonly format: ResumeSourceFormat;
  readonly text: string;
}

/** 抽取失败：底层库报错原文只进日志（`reason`），界面按 `code` 出中文提示（4.1-06）。 */
export interface FailedSourceText {
  readonly status: 'failed';
  readonly code: SourceFailureCode;
  readonly reason: string;
}

/** `extractSourceText` 的返回。 */
export type SourceTextResult = ExtractedSourceText | FailedSourceText;

/** 一条简历导入的完整结果：成功出文档、过短出读数、失败出错误码，三条路径都带同一套 issues。 */
export type ResumeSourceResult =
  | {
      readonly status: 'ok';
      readonly format: ResumeSourceFormat;
      readonly document: ResumeDocument;
      readonly issues: readonly ParseIssue[];
      readonly textLength: number;
    }
  | {
      readonly status: 'too-short';
      /** 过短通道仍然带判定出的格式：扫描件是「读得出是 PDF 但没文本层」，界面要按格式给补录指引。 */
      readonly format: ResumeSourceFormat;
      readonly issues: readonly ParseIssue[];
      readonly textLength: number;
    }
  | { readonly status: 'failed'; readonly code: SourceFailureCode; readonly reason: string };

/** 实测在 Node 主进程内抽 PDF 文本必需的四项选项（不关掉 eval 与字体加载会在无 DOM 环境里报错）。 */
const PDF_TEXT_OPTIONS = {
  isEvalSupported: false,
  useSystemFonts: true,
  disableFontFace: true,
  verbosity: 0,
} as const;

/**
 * pdf.js 文本项的结构切片——只声明实测用到的三处，不依赖它的类型入口（版本间漂移大）。
 *
 * 与下面的 `joinTextItems` 一起导出：这两样是缩进归档那一判据的**测试缝**（同 `sections.ts` 的
 * `splitEntryBlocks` 口径）。真实夹具 PDF 造不出"同一页不同左 x"的版面，硬造就要往 `@auto-cc/testing`
 * 再加第二套生成器（§2.7 禁第二套同类基础设施），而判据本身是纯函数，直接喂项数组就能逐档断言。
 */
export interface PdfTextChunk {
  readonly str?: unknown;
  readonly hasEOL?: unknown;
  /** 六元仿射矩阵，`[4]` 是该文本项的绘制起点 x（单位 pt）——spike S2 的读数就取自这里。
   *  成员类型写 `unknown` 而不是 `number`：这一格是外部库的形状切片，元素是不是数要在用的时候判（§6.2）。 */
  readonly transform?: readonly unknown[];
}

/** 实测到的 pdf.js 文档对象切片（只有抽文本用到的三个成员）。 */
interface PdfDocumentLike {
  readonly numPages: number;
  getPage(pageNumber: number): Promise<{
    getTextContent(): Promise<{ readonly items: readonly PdfTextChunk[] }>;
    cleanup(): void;
  }>;
}

/** pdf.js 的加载任务切片——释放入口在任务上而不是文档代理上（实测 6.3.289 的代理没有 `destroy`）。 */
interface PdfLoadingTaskLike {
  readonly promise: Promise<PdfDocumentLike>;
  destroy(): Promise<void>;
}

/**
 * 按魔数判定输入格式（不看扩展名——用户在文件选择框里改名的情况极多）。
 * @param bytes 文件字节
 * @returns 判定出的格式；空文件或既不是 PDF/DOCX 也不是可解码文本时返回 `null`
 */
export function detectFormat(bytes: Uint8Array): ResumeSourceFormat | null {
  if (bytes.length === 0) return null;
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf'; // %PDF-
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return 'docx'; // PK\3\4：DOCX 是 zip
  const decoded = decodeUtf8(bytes);
  if (decoded === null) return null;
  return /^#{1,6}[ \t]+\S/m.test(decoded) ? 'markdown' : 'text';
}

/**
 * 计算导入源的幂等键（spec 4.1-07 的「来源 hash」半边）。
 * 必须在把字节交给 pdf.js **之前**算——实测 `getDocument` 会移交（detach）传入的 ArrayBuffer，
 * 之后同一份字节再读就是空壳。
 * @param bytes 文件字节
 * @returns sha256 十六进制串（摘要实现只在 `core/file-read` 一处，编辑轨的产物指纹读同一份口径）
 */
export function sourceHashOf(bytes: Uint8Array): string {
  return sha256Hex(bytes);
}

/**
 * 字节 → 文本。识别失败与抽取失败都返回结构化结果，不向主进程抛异常（4.1-06）。
 * @param bytes 文件字节；调用方若还要用这份字节，请自行传副本（见 `sourceHashOf` 的 detach 说明）
 * @returns `extracted`（带格式）或 `failed`（带机器码与技术原因）
 */
export async function extractSourceText(bytes: Uint8Array): Promise<SourceTextResult> {
  const format = detectFormat(bytes);
  if (format === null) {
    return bytes.length === 0
      ? { status: 'failed', code: 'empty', reason: 'file is empty' }
      : { status: 'failed', code: 'unsupported-format', reason: 'not a pdf/docx/text file' };
  }
  // 交给第三方库前先复制，避免它的失败或缓冲区移交影响调用方手里的原始字节。
  const owned = bytes.slice(0);
  if (format === 'pdf') return extractPdfText(owned);
  if (format === 'docx') return extractDocxText(owned);
  const decoded = decodeUtf8(owned);
  if (decoded === null) return { status: 'failed', code: 'unsupported-format', reason: 'not valid utf-8' };
  return { status: 'extracted', format, text: decoded };
}

/**
 * 导入入口的完整一步：字节 → 文本 → `ResumeDocument`（4.1-01 的机检对象）。
 * @param bytes 文件字节
 * @param docId 生成文档的 id（与 P3.1 的 `createEmptyDocument` 同一套寻址）
 * @param nowMs 更新时间戳（毫秒），由调用方注入以保证可测
 * @returns 三条路径之一：文档 / 过短读数 / 抽取失败
 */
export async function parseResumeSource(bytes: Uint8Array, docId: string, nowMs: number): Promise<ResumeSourceResult> {
  const extracted = await extractSourceText(bytes);
  if (extracted.status === 'failed') return extracted;
  const parsed = parseResumeText(extracted.text, docId, nowMs);
  return parsed.status === 'ok' ? { ...parsed, format: extracted.format } : { ...parsed, format: extracted.format };
}

/**
 * 用 pdf.js 抽 PDF 正文。
 * @param bytes PDF 字节（所有权已归本函数）
 * @returns 抽出文本或 `invalid-pdf` 失败；抽不到文本（图片型 PDF）返回空串而不是失败，让扫描件判定只有一处
 */
async function extractPdfText(bytes: Uint8Array): Promise<SourceTextResult> {
  let loadingTask: PdfLoadingTaskLike | null = null;
  try {
    const pdfModule = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
      getDocument(source: unknown): PdfLoadingTaskLike;
    };
    loadingTask = pdfModule.getDocument({ data: bytes, ...PDF_TEXT_OPTIONS });
    const document = await loadingTask.promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      try {
        pages.push(joinTextItems((await page.getTextContent()).items));
      } finally {
        page.cleanup();
      }
    }
    return { status: 'extracted', format: 'pdf', text: pages.join('\n').replace(/\n{3,}/g, '\n\n') };
  } catch (error) {
    return { status: 'failed', code: 'invalid-pdf', reason: reasonOf(error) };
  } finally {
    if (loadingTask !== null) await loadingTask.destroy();
  }
}

/**
 * 用 mammoth 抽 DOCX 正文。
 * @param bytes DOCX 字节（所有权已归本函数）
 * @returns 抽出文本或 `invalid-docx` 失败（`.doc` 老格式与非 zip 文件都落在这里）
 */
async function extractDocxText(bytes: Uint8Array): Promise<SourceTextResult> {
  try {
    const { extractRawText } = await import('mammoth');
    const { value } = await extractRawText({ buffer: Buffer.from(bytes) });
    return { status: 'extracted', format: 'docx', text: value };
  } catch (error) {
    return { status: 'failed', code: 'invalid-docx', reason: reasonOf(error) };
  }
}

/**
 * 一档缩进对应的水平距离（pt）。
 * 取值来自真实简历那一份的左 x 直方图读数 **90 / 101.6 / 111 / 154**（plan `03-resume-pdf` §14 的 S2）：
 * 相邻两档差约 10pt，正是一个中文字符在该文件字号（10.45pt）下的宽度——所以这不是魔法倍数，是量出来的。
 */
const INDENT_UNIT_PT = 10;

/**
 * 取一个文本项的绘制起点 x。
 * @param item pdf.js 的文本项（形状切片，可能缺字段）
 * @returns 左 x（pt）；该 item 没带 `transform` 或值不是有限数时返回 `null`（扫描件与异形 PDF 走这一支）
 */
function leftXOf(item: PdfTextChunk): number | null {
  const transform = item.transform;
  if (transform === undefined) return null;
  const rawX = transform[4];
  return typeof rawX === 'number' && Number.isFinite(rawX) ? rawX : null;
}

/**
 * 把一行的左 x 折成语法里的缩进档。
 * 只认两档（裁定㉘ 第 2 条把层级封顶在二级）：基线与第一档差都算"贴着正文走"，由符号本身决定它是不是一条列表项；
 * 第二档及更深才写缩进——符号在前、缩进在后，`normalizeRichLine` 才读得出层级。
 * @param leftX 该行的最小左 x（pt）
 * @param baseline 该页的最小左 x（pt）
 * @returns 行首缩进串（空串或一档 `NESTED_INDENT`）
 */
function indentFor(leftX: number | null, baseline: number | null): string {
  if (leftX === null || baseline === null) return '';
  return Math.round((leftX - baseline) / INDENT_UNIT_PT) >= 2 ? NESTED_INDENT : '';
}

/**
 * 把 pdf.js 的文本项拼回带换行的正文，并**把版面缩进带出来**（spec 4.1-18）。
 * 断行依据是 `hasEOL`（实测同一行的两列之间由 pdf.js 插入空格项，因此直接累加 `str` 即可保持「公司 时间」同行）。
 * 两趟处理：先按行收字与左 x（一行的左 x 取该行**最小**的那个 item x，符号项通常比文字更靠左），
 * 再以该页最小左 x 为基线折缩进档——不在第一趟里做，是因为基线要看到整页才知道。
 * @param items 单页文本项
 * @returns 该页正文（行首可能带一档缩进空格）
 */
export function joinTextItems(items: readonly PdfTextChunk[]): string {
  const collected: { text: string; leftX: number | null }[] = [];
  let currentLine = '';
  let lineLeftX: number | null = null;
  const flushLine = (): void => {
    if (currentLine !== '') collected.push({ text: currentLine, leftX: lineLeftX });
    currentLine = '';
    lineLeftX = null;
  };
  for (const item of items) {
    if (typeof item.str === 'string' && item.str !== '') {
      currentLine += item.str;
      const x = leftXOf(item);
      if (x !== null && (lineLeftX === null || x < lineLeftX)) lineLeftX = x;
    }
    if (item.hasEOL === true) flushLine();
  }
  flushLine();
  const xs = collected.map((line) => line.leftX).filter((x): x is number => x !== null);
  const baseline = xs.length === 0 ? null : Math.min(...xs);
  return collected.map((line) => `${indentFor(line.leftX, baseline)}${line.text}`).join('\n');
}

/**
 * 判断字节序列是否以给定前缀开头。
 * @param bytes 文件字节
 * @param prefix 前缀各字节的值
 * @returns 是否匹配
 */
function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

/**
 * 严格 UTF-8 解码（失败即判定为二进制输入，不用 `TextDecoder` 的静默替换字符）。
 * @param bytes 文件字节
 * @returns 解码结果；不是合法 UTF-8 时返回 `null`
 */
function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** 取底层库错误的技术原因文本（进日志用，不进界面）。 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
