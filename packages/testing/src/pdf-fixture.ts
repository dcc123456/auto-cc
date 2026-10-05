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
