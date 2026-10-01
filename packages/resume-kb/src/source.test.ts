/**
 * `source.ts` 单元测试（spec 4.1-01 的 PDF / DOCX / Markdown 三条输入腿、4.1-05 的扫描件判定、4.1-06 的失败路径）。
 *
 * 夹具在测试内生成，不放二进制样本：最小 PDF 只能用 Type1/Helvetica（不含中日韩字形），所以 **PDF 腿用英文简历**；
 * DOCX 是 XML 文本，可以带中文，所以 **DOCX 腿复用 4.1-a 的中文语料**，证明两条依赖腿落到同一套模型。
 * 所有内容均为虚构，不含真实个人信息（spec 数据纪律）。
 */
import { describe, expect, it } from 'vitest';

import { detectFormat, parseResumeSource, sourceHashOf, extractSourceText } from './source.js';

/** 更新时间戳固定值，保证文档 `updatedAt` 可断言。 */
const NOW_MS = 1_700_000_000_000;

/** PDF 腿的英文简历正文（逐行，**不带空行**——真实 PDF 抽出来就是这样：标题行紧接着条目行）。 */
const PDF_RESUME_LINES = [
  'Jane Doe',
  'jane.doe@example.com',
  'Summary',
  'Five years building ingestion pipelines; cut p99 latency by 40 percent on three services.',
  'Work Experience',
  'ByteDance | Backend Engineer | 2021.03 - 2024.06',
  'Rewrote the order sync job from batch to streaming.',
  'Education',
  'Fudan University | 2011.09 - 2015.06',
];

/** DOCX 腿的中文简历段落（与 4.1-a 的 `sections.test.ts` 语料同形，断言口径因此可复用）。 */
const DOCX_RESUME_PARAGRAPHS = [
  '张三',
  '电话：13800001111 邮箱：zhangsan@example.com',
  '## 工作经历',
  '星桥科技｜后端工程师 2021.03-2024.06',
  '负责订单同步服务的重构，日均处理量提升三倍',
  '## 教育经历',
  '东海大学 计算机科学与技术 学士 2015.09-2019.06',
];

/**
 * 生成最小合法 PDF：Helvetica Type1 + 未压缩内容流，一行一个 `Tj`。
 * 括号与反斜杠会被剥掉（PDF 字符串转义不值得在测试里复刻）。
 * @param lines 逐行文本
 * @returns PDF 字节
 */
function minimalPdf(lines: readonly string[]): Uint8Array {
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
 * 把若干对象拼成带交叉引用表的 PDF 文件。
 * @param objects 对象正文（不含 `n 0 obj` 头）
 * @returns PDF 字节
 */
function wrapPdf(objects: readonly string[]): Uint8Array {
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((content, index) => {
    offsets.push(Buffer.byteLength(out));
    out += `${String(index + 1)} 0 obj\n${content}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(out);
  out += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xrefStart)}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

/**
 * 生成最小合法 DOCX：STORE 法 zip + 三个部件，每段一个 `<w:p>`（真实 Word 的形状）。
 * @param paragraphs 逐段文本
 * @returns DOCX 字节
 */
function minimalDocx(paragraphs: readonly string[]): Uint8Array {
  const documentXml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs
    .map((paragraph) => `<w:p><w:r><w:t xml:space="preserve">${paragraph}</w:t></w:r></w:p>`)
    .join('')}<w:sectPr/></w:body></w:document>`;
  return storeZip([
    [
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ],
    [
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ],
    ['word/document.xml', documentXml],
  ]);
}

/**
 * 无压缩（STORE）zip 写入器——测试里不需要真正的压缩，只要容器合法。
 * @param entries 部件名与内容
 * @returns zip 字节
 */
function storeZip(entries: ReadonlyArray<readonly [string, string]>): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  entries.forEach(([name, content]) => {
    const nameBuf = Buffer.from(name, 'utf8');
    const dataBuf = Buffer.from(content, 'utf8');
    const crc = crc32(new Uint8Array(dataBuf));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(dataBuf.length, 18);
    local.writeUInt32LE(dataBuf.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, dataBuf);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(dataBuf.length, 20);
    central.writeUInt32LE(dataBuf.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + dataBuf.length;
  });
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, centralBuf, end]));
}

/**
 * zip 条目校验和（STORE 条目必填）。
 * @param bytes 条目内容
 * @returns CRC32 无符号整数
 */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 按区块种类取条目字段值。
 * @param document 解析出的文档
 * @param kind 区块种类
 * @param entryIndex 条目序号
 * @param fieldKey 字段键
 * @returns 字段值；区块或字段不存在时 `undefined`
 */
function fieldOf(
  document: {
    sections: readonly { kind: string; entries: readonly { fields: readonly { key: string; value: string }[] }[] }[];
  },
  kind: string,
  entryIndex: number,
  fieldKey: string,
): string | undefined {
  const section = document.sections.find((candidate) => candidate.kind === kind);
  return section?.entries[entryIndex]?.fields.find((field) => field.key === fieldKey)?.value;
}

describe('4.1-01 格式判定', () => {
  it('按魔数而不是扩展名识别', () => {
    expect(detectFormat(minimalPdf(['a']))).toBe('pdf');
    expect(detectFormat(minimalDocx(['a']))).toBe('docx');
    expect(detectFormat(new Uint8Array(Buffer.from('## 工作经历\n内容', 'utf8')))).toBe('markdown');
    expect(detectFormat(new Uint8Array(Buffer.from('纯文本简历', 'utf8')))).toBe('text');
    expect(detectFormat(new Uint8Array(0))).toBeNull();
    expect(detectFormat(new Uint8Array([0xff, 0xfe, 0x00, 0x01]))).toBeNull();
  });

  it('抽取不会破坏调用方手里的字节（pdf.js 会移交 ArrayBuffer，实测过）', async () => {
    const bytes = minimalPdf(PDF_RESUME_LINES);
    const hashBefore = sourceHashOf(bytes);
    expect(await extractSourceText(bytes)).toMatchObject({ status: 'extracted', format: 'pdf' });
    expect(bytes.length).toBeGreaterThan(0);
    expect(sourceHashOf(bytes)).toBe(hashBefore);
  });
});

describe('4.1-01 三条输入腿都产出结构化经历实体', () => {
  it('PDF 英文简历', async () => {
    const result = await parseResumeSource(minimalPdf(PDF_RESUME_LINES), 'doc-pdf', NOW_MS);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.format).toBe('pdf');
    expect(result.document.sections.map((section) => section.kind)).toEqual(['summary', 'experience', 'education']);
    expect(fieldOf(result.document, 'experience', 0, 'company')).toBe('ByteDance');
    expect(fieldOf(result.document, 'experience', 0, 'role')).toBe('Backend Engineer');
    expect(fieldOf(result.document, 'experience', 0, 'period')).toBe('2021-03 - 2024-06');
    expect(fieldOf(result.document, 'education', 0, 'school')).toMatch(/Fudan/);
  });

  it('DOCX 中文简历与文本腿同形', async () => {
    const result = await parseResumeSource(minimalDocx(DOCX_RESUME_PARAGRAPHS), 'doc-docx', NOW_MS);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.format).toBe('docx');
    expect(result.document.sections.map((section) => section.kind)).toEqual(['experience', 'education']);
    expect(fieldOf(result.document, 'experience', 0, 'company')).toBe('星桥科技');
    expect(fieldOf(result.document, 'experience', 0, 'role')).toBe('后端工程师');
    expect(fieldOf(result.document, 'experience', 0, 'period')).toBe('2021-03 - 2024-06');
    expect(fieldOf(result.document, 'education', 0, 'school')).toBe('东海大学');
  });

  it('Markdown 文本与 DOCX 腿同源同形（同一段中文语料走两种输入）', async () => {
    const bytes = new Uint8Array(Buffer.from(DOCX_RESUME_PARAGRAPHS.join('\n\n'), 'utf8'));
    const result = await parseResumeSource(bytes, 'doc-md', NOW_MS);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.format).toBe('markdown');
    expect(result.document.sections.map((section) => section.kind)).toEqual(['experience', 'education']);
    expect(fieldOf(result.document, 'experience', 0, 'company')).toBe('星桥科技');
    expect(fieldOf(result.document, 'experience', 0, 'period')).toBe('2021-03 - 2024-06');
  });
});

describe('4.1-05 抽文本过短走明确失败', () => {
  it('图片型 PDF 抽出空文本 → too-short，而不是空文档', async () => {
    const result = await parseResumeSource(minimalPdf([' ', ' ']), 'doc-scan', NOW_MS);
    expect(result.status).toBe('too-short');
    if (result.status !== 'too-short') return;
    expect(result.textLength).toBe(0);
    expect(result.issues.some((issue) => issue.code === 'text-too-short')).toBe(true);
  });

  it('PDF 里只有一行残句同样判过短', async () => {
    const result = await parseResumeSource(minimalPdf(['Backend Engineer 2021.03-2024.06']), 'doc-scan2', NOW_MS);
    expect(result.status).toBe('too-short');
  });
});

describe('4.1-06 损坏输入不抛异常', () => {
  it.each([
    ['空文件', new Uint8Array(0), 'empty'],
    ['带 PDF 头的垃圾', new Uint8Array(Buffer.from('%PDF-1.4\nthis is not a pdf', 'utf8')), 'invalid-pdf'],
    ['带 zip 头的非 zip', new Uint8Array(Buffer.from('PK\u0003\u0004not a zip at all', 'utf8')), 'invalid-docx'],
    ['非 UTF-8 二进制', new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), 'unsupported-format'],
  ] as Array<[string, Uint8Array, string]>)('%s → %s', async (_label, bytes, expectedCode) => {
    const result = await parseResumeSource(bytes, 'doc-broken', NOW_MS);
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.code).toBe(expectedCode);
  });

  it('脱敏在 PDF 腿上也生效：邮箱不以原文出现在文档里', async () => {
    const result = await parseResumeSource(minimalPdf(PDF_RESUME_LINES), 'doc-redact', NOW_MS);
    if (result.status !== 'ok') throw new Error('预期解析成功');
    expect(JSON.stringify(result.document)).not.toContain('jane.doe@example.com');
    expect(result.issues.some((issue) => issue.code === 'sensitive-redacted')).toBe(true);
  });
});
