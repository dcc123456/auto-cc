/**
 * 测试用的最小合法 PDF 生成器（从 `packages/resume-kb/src/source.test.ts` 抽来，AGENTS.md §2.2：
 * 同一逻辑第二次出现就抽公共层——P4 的文本抽取与 P3 编辑轨的装载判定都需要一份「不依赖任何外部文件、
 * 又能被两套解析器读」的 PDF）。
 *
 * 产物的构造口径：Helvetica Type1 字体 + 未压缩内容流，一行一个 `Tj`，页面 `MediaBox` 是 A4（595×842 pt）。
 * 手写交叉引用表而不是用库生成，是为了让夹具**独立于被测的 PDF 库**——用 `pdf-lib` 造再让 `pdf-lib` 读，
 * 等于什么都没测（spec 3.4-03 要的是"装载"一条腿能对外部输入负责）。
 */

/**
 * 把若干对象拼成带交叉引用表的 PDF 文件。
 * @param objects 对象正文（不含 `n 0 obj` 头），下标即对象号（从 1 起）
 * @param trailerEntries 追加进 trailer 字典的条目（加密文档要把 `/Encrypt n 0 R` 写在这里，别处没有第二写法）
 * @returns PDF 字节（latin1 编码，交叉引用偏移按字节算）
 */
function wrapPdf(objects: readonly string[], trailerEntries = ''): Uint8Array {
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((content, index) => {
    offsets.push(Buffer.byteLength(out));
    out += `${String(index + 1)} 0 obj\n${content}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(out);
  out += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R ${trailerEntries}>>\nstartxref\n${String(xrefStart)}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

/**
 * 生成最小合法 PDF：Helvetica Type1 + 未压缩内容流，一行一个 `Tj`。
 * 括号与反斜杠会被剥掉（PDF 字符串转义不值得在测试里复刻）。
 * @param lines 逐行文本（拉丁字形；CJK 请走真实字体内嵌那条腿，见 plan §7.2）
 * @returns 单页 A4 的 PDF 字节
 */
export function minimalPdf(lines: readonly string[]): Uint8Array {
  const body = `BT /F1 12 Tf 50 800 Td ${lines
    .map((line) => `(${line.replace(/[()\\]/g, '')}) Tj 0 -20 Td`)
    .join(' ')} ET`;
  return wrapPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${String(Buffer.byteLength(body))} >>\nstream\n${body}\nendstream`,
  ]);
}

/**
 * 生成 N 页的最小合法 PDF（页数腿要用：3.5-07 的页面增删、3.6-08 的多页交互都得有"不止一页"的输入）。
 * @param pageCount 页数（小于 1 时按 1 页造，避免造出结构上不合法的文档）
 * @returns 每页都是 A4 的 PDF 字节
 */
export function minimalMultiPagePdf(pageCount: number): Uint8Array {
  const total = Math.max(1, Math.floor(pageCount));
  // 对象布局：1 目录、2 页树、3 字体，之后每页一个页对象 + 一个内容流对象。
  const firstPageObject = 4;
  const objects: string[] = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [${Array.from({ length: total }, (_, index) => `${String(firstPageObject + index * 2)} 0 R`).join(' ')}] /Count ${String(total)} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (let page = 0; page < total; page += 1) {
    const contentRef = firstPageObject + page * 2 + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${String(contentRef)} 0 R >>`,
    );
    const body = `BT /F1 12 Tf 50 800 Td (page ${String(page + 1)}) Tj ET`;
    objects.push(`<< /Length ${String(Buffer.byteLength(body))} >>\nstream\n${body}\nendstream`);
  }
  return wrapPdf(objects);
}

/**
 * 一条内容流算子的记录（`styledResumePdf` 的构造表用它说"这一格本来该被抽成什么"）。
 */
export interface StyledPdfExpectation {
  /** 期望抽到的文本（逐字）。 */
  readonly text: string;
  /** 资源名（`/F1` 之类），抽取侧要能读回字族提示。 */
  readonly fontName: string;
  /** 字号（pt）。 */
  readonly sizePt: number;
  /** 基线左下角（pt，PDF 坐标：原点在左下）。 */
  readonly xPt: number;
  readonly yPt: number;
  /** 墨色 `[r,g,b]`，0..1；`null` 表示这一格没写颜色算子（沿默认黑）。 */
  readonly rgb: readonly [number, number, number] | null;
  /** 旋转角（度）；非 0 的那些是"已知丢失项"，不进恢复率的分母。 */
  readonly rotationDeg: number;
}

/**
 * `styledResumePdf()` 的内容清单：七格文字（三种字族、三种字号、两格有色、一格旋转）
 * + 一条色带 + 一条分隔线。写在这里而不是散在字符串里，是为了让判据能拿**同一份表**当期望值。
 */
export const STYLED_PDF_RUNS: readonly StyledPdfExpectation[] = [
  { text: 'Jane Doe', fontName: 'F2', sizePt: 18, xPt: 50, yPt: 800, rgb: null, rotationDeg: 0 },
  { text: 'Work Experience', fontName: 'F1', sizePt: 12, xPt: 50, yPt: 770, rgb: null, rotationDeg: 0 },
  { text: 'Led platform migration', fontName: 'F3', sizePt: 12, xPt: 50, yPt: 750, rgb: null, rotationDeg: 0 },
  {
    text: 'Senior Engineer',
    fontName: 'F3',
    sizePt: 12,
    xPt: 50,
    yPt: 730,
    rgb: [0.639, 0.086, 0.086],
    rotationDeg: 0,
  },
  { text: 'Shanghai China', fontName: 'F1', sizePt: 12, xPt: 50, yPt: 710, rgb: [0.043, 0.361, 0.314], rotationDeg: 0 },
  { text: 'Total 999 hires', fontName: 'F1', sizePt: 11, xPt: 50, yPt: 640, rgb: null, rotationDeg: 0 },
  { text: 'ROTATED WATERMARK', fontName: 'F1', sizePt: 12, xPt: 300, yPt: 400, rgb: null, rotationDeg: 45 },
] as const;

/** 色带（填充矩形）：`styledResumePdf` 画它一条，抽取侧的矩形恢复率分母就是它。 */
export const STYLED_PDF_BAND = { xPt: 50, yPt: 690, widthPt: 495, heightPt: 34, rgb: [0.969, 0.961, 0.949] } as const;

/** 分隔线（描边直线）：与色带同属"非文字元素"，但画法完全不同（`m`/`l`/`S` 而不是 `re`/`f`）。 */
export const STYLED_PDF_RULE = { x1Pt: 50, yPt: 680, x2Pt: 545, rgb: [0.502, 0.502, 0.502] } as const;

/**
 * 生成一份**带样式**的单页 PDF（spec 3.8-01 的输入：抽取完整性要有可核对的期望值）。
 *
 * 与 `minimalPdf` 同一个口径：手写对象与交叉引用表，**不用 pdf-lib 造再让 pdf-lib 读**，
 * 也不用 pdf-lib 造再让 pdf.js 读（那等于拿被测引擎的另一半自证）。
 * 三条字族都是标准 14 型（Helvetica / Times-Roman / Helvetica-Bold），因此不需要内嵌字体，
 * 任何解析器都能读到 `/BaseFont`，字族提示这一条腿才是真的在测抽取而不是测字体装载。
 * @returns 单页 A4 的 PDF 字节（内容清单见 `STYLED_PDF_RUNS` / `STYLED_PDF_BAND` / `STYLED_PDF_RULE`）
 */
export function styledResumePdf(): Uint8Array {
  const ops: string[] = [
    // 色带：先画，后面的文字才盖在它上面（与真实简历模板的"区块底色"同一顺序）。
    'q 0.969 0.961 0.949 rg 50 690 495 34 re f Q',
    // 分隔线：描边一条 0.8pt 的灰线。
    `q 0.502 0.502 0.502 RG 0.8 w ${String(STYLED_PDF_RULE.x1Pt)} 680 m ${String(STYLED_PDF_RULE.x2Pt)} 680 l S Q`,
  ];
  for (const run of STYLED_PDF_RUNS) {
    const color = run.rgb ? `${run.rgb.map((channel) => channel.toFixed(3)).join(' ')} rg ` : '';
    // 旋转那一格走文本矩阵（Tm 的 a/b/c/d 四条就是旋转 + 缩放），与真实文档里的斜切同一画法。
    const rad = (run.rotationDeg * Math.PI) / 180;
    const cos = Math.cos(rad).toFixed(3);
    const sin = Math.sin(rad).toFixed(3);
    // 有色的那一格包在一对 `q…Q` 里：真实生成器都这么写，而 PDF 的颜色状态本来会一路延续到下一次赋值——
    // 不包的话，后面没写颜色的格子会"继承"到前一格的红，抽出来看着对、其实测不到状态进出这条腿。
    const open = run.rgb ? 'q ' : '';
    const close = run.rgb ? ' Q' : '';
    ops.push(
      `${open}BT ${color}/${run.fontName} ${String(run.sizePt)} Tf ${cos} ${sin} ${(-Math.sin(rad)).toFixed(3)} ${cos} ${String(run.xPt)} ${String(run.yPt)} Tm (${run.text.replace(/[()\\]/g, '')}) Tj ET${close}`,
    );
  }
  const body = ops.join('\n');
  return wrapPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R /F3 6 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    `<< /Length ${String(Buffer.byteLength(body))} >>\nstream\n${body}\nendstream`,
  ]);
}

/**
 * 生成一份「结构合法但带加密字典」的最小 PDF（spec 3.4-03 / plan §7.10 的加密确定态腿）。
 *
 * 造法与上面两条同一个口径：手写 trailer 里的 `/Encrypt` 引用 + 一个 `/Filter /Standard` 字典，
 * **不做真加密**（不需要能解出内容，只需要让解析器认它是加密文档）。实测（本机 `pdf-lib` 1.17.1）：
 * 这样一份文件在 `ignoreEncryption: true` 下装载成功、`isEncrypted` 为真，与损坏文件的抛异常可分开判。
 * @param lines 逐行文本（同 `minimalPdf`）
 * @returns 单页 A4、带标准加密字典的 PDF 字节
 */
export function minimalEncryptedPdf(lines: readonly string[]): Uint8Array {
  const body = `BT /F1 12 Tf 50 800 Td ${lines
    .map((line) => `(${line.replace(/[()\\]/g, '')}) Tj 0 -20 Td`)
    .join(' ')} ET`;
  // 加密字典是第 6 号对象，trailer 用 `/Encrypt 6 0 R` 指过去（对象号写死在这里，因为上面五个对象的顺序也是写死的）。
  return wrapPdf(
    [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      `<< /Length ${String(Buffer.byteLength(body))} >>\nstream\n${body}\nendstream`,
      '<< /Filter /Standard /V 1 /R 2 /Length 40 /P -3968' +
        ' /U <d8a0d2c0c8a4a0c0c0a0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0>' +
        ' /O <e8a0d2c0c8a4a0c0c0a0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0> >>',
    ],
    '/Encrypt 6 0 R ',
  );
}
