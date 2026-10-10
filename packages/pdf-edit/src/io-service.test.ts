/**
 * `pdf.io` 服务单元测试（spec 3.4-03 的打开腿 + 3.5-12 的字节腿 + plan §7.4 的第一条口 + §7.10 的确定态）。
 *
 * 判据面只有三件事：**读得到度量**、**搬得出字节**与**读不到时给一个码**。文件一律写在系统临时目录里
 * （AGENTS.md §7.5：测试产物不进仓库），路径是绝对路径——渲染层给的就是绝对路径，
 * 相对路径必须被拒（主进程的工作目录不是用户预期的那一个）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError, asApp, Context, type Fiber } from '@auto-cc/core';
import { sha256Hex } from '@auto-cc/core/file-read';
import { afterAll, describe, expect, it } from 'vitest';
import { minimalEncryptedPdf, minimalMultiPagePdf, minimalPdf } from '@auto-cc/testing';

import { PdfIoService } from './io-service.js';

const sandboxes: string[] = [];
const fibers: Fiber[] = [];

/** 建一个系统临时目录（`afterAll` 清理）。 */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-pdf-io-'));
  sandboxes.push(dir);
  return dir;
}

/**
 * 把字节写成临时目录里的一份文件。
 * @param dir 哪个沙箱
 * @param name 文件名
 * @param bytes 文件字节
 * @returns 绝对路径，交给 `open`
 */
function writeFile(dir: string, name: string, bytes: Uint8Array): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, bytes);
  return filePath;
}

/**
 * 挂起一份 `pdf.io`。
 * @param maxBytes 单次打开的字节上限（用于演「误选大文件」这条失败腿）
 * @returns 服务实例
 */
async function boot(maxBytes = 5_242_880): Promise<PdfIoService> {
  const ctx = new Context();
  fibers.push(await ctx.plugin(PdfIoService, { maxBytes }));
  return asApp(ctx)['pdf.io'];
}

describe('3.4-03 打开腿：pdf.io.open 只回度量读数', () => {
  it('三页文件：页数、逐页宽高、来源哈希都回来', async () => {
    const dir = tempDir();
    const bytes = minimalMultiPagePdf(3);
    const receipt = await (await boot()).open(writeFile(dir, 'three.pdf', bytes));

    expect(receipt.pageCount).toBe(3);
    expect(receipt.pages).toEqual([1, 2, 3].map((number) => ({ number, widthPt: 595, heightPt: 842 })));
    expect(receipt.sourceHash).toBe(sha256Hex(bytes));
  });

  it('打开是纯读：源文件的字节一个都没变（spec 3.5-09 的前半句）', async () => {
    const dir = tempDir();
    const filePath = writeFile(dir, 'resume.pdf', minimalPdf(['Jane Doe']));
    const before = sha256Hex(new Uint8Array(readFileSync(filePath)));

    await (await boot()).open(filePath);
    expect(sha256Hex(new Uint8Array(readFileSync(filePath)))).toBe(before);
  });

  it('单页简历与多页文件走的是同一条口：回执形状一致，界面不必分两套处置', async () => {
    const dir = tempDir();
    const io = await boot();
    const single = await io.open(writeFile(dir, 'one.pdf', minimalPdf(['Fudan University'])));
    const multi = await io.open(writeFile(dir, 'two.pdf', minimalMultiPagePdf(2)));

    expect(Object.keys(single).sort()).toEqual(Object.keys(multi).sort());
    expect(single.pages).toHaveLength(1);
    expect(multi.pages).toHaveLength(2);
  });
});

describe('plan §7.10 的确定态：读不出一律 PDF_EDIT_READ_FAILED', () => {
  /** 六条失败腿：前四条是「读不到字节」，后两条是「字节读到了但这份 PDF 用不了」。 */
  const cases: readonly { name: string; maxBytes?: number; prepare: (dir: string) => string; code?: string }[] = [
    { name: '相对路径', prepare: () => 'relative/resume.pdf' },
    { name: '文件不存在', prepare: (dir) => join(dir, 'missing.pdf') },
    { name: '是个目录', prepare: (dir) => dir },
    { name: '超过字节上限', maxBytes: 1024, prepare: (dir) => writeFile(dir, 'big.pdf', new Uint8Array(4096)) },
    {
      name: '结构损坏',
      prepare: (dir) => writeFile(dir, 'broken.pdf', new Uint8Array(Buffer.from('%PDF-1.4\n这不是合法的 PDF 结构\n'))),
      code: 'invalid-pdf',
    },
    {
      name: '加密文档',
      prepare: (dir) => writeFile(dir, 'locked.pdf', minimalEncryptedPdf(['Jane Doe'])),
      code: 'encrypted',
    },
  ];

  for (const item of cases) {
    it(`${item.name}：一个码收口，中文提示可读，details 说清是哪一种`, async () => {
      const dir = tempDir();
      const io = await boot(item.maxBytes ?? 5_242_880);
      const error = (await io.open(item.prepare(dir)).catch((caught: unknown) => caught)) as AppError;

      expect(error).toBeInstanceOf(AppError);
      expect(error.code).toBe('PDF_EDIT_READ_FAILED');
      expect(error.message).toMatch(/[\u4e00-\u9fa5]/);
      // 4.1-06 立过的口径：错误能被网关转成结构化载荷，界面拿到的是码而不是裸异常。
      expect(AppError.from(error)).toMatchObject({ code: 'PDF_EDIT_READ_FAILED' });
      if (item.code !== undefined) expect(error.details).toMatchObject({ code: item.code });
    });
  }
});

describe('3.5-12 字节腿：pdf.io.bytes 把整份文件交给渲染层', () => {
  it('回的是逐字相同的字节，且与 `open` 共用同一份上限（不另立第二档尺度）', async () => {
    const dir = tempDir();
    const bytes = minimalMultiPagePdf(3);
    const filePath = writeFile(dir, 'three.pdf', bytes);

    // `bytes` 是同步的读盘（网关那边 `await` 一个非 Promise 同样成立），所以这里不套 `await`。
    const value = (await boot()).bytes(filePath);
    expect(value).toBeInstanceOf(Uint8Array);
    expect(sha256Hex(value)).toBe(sha256Hex(bytes));
    expect(value.byteLength).toBe(bytes.byteLength);
  });

  it('字节腿只读不解析：结构损坏的文件照样把字节交出去，判"是不是 PDF"是渲染层 pdf.js 的事', async () => {
    const dir = tempDir();
    const broken = new Uint8Array(Buffer.from('%PDF-1.4\n这不是合法的 PDF 结构\n'));
    const filePath = writeFile(dir, 'broken.pdf', broken);

    // 同一份字节经 `open` 是被拒的（`invalid-pdf`）——两条口的分工就在这：一条量得出度量，一条只搬字节。
    const io = await boot();
    await expect(io.open(filePath)).rejects.toBeInstanceOf(AppError);
    const value = io.bytes(filePath);
    expect(sha256Hex(value)).toBe(sha256Hex(broken));
  });

  it('读不到字节那四条腿与 `open` 同码同话术：界面上的处置完全相同，就不另开支新码', async () => {
    const cases: readonly { name: string; maxBytes?: number; prepare: (dir: string) => string }[] = [
      { name: '相对路径', prepare: () => 'relative/resume.pdf' },
      { name: '文件不存在', prepare: (dir) => join(dir, 'missing.pdf') },
      { name: '是个目录', prepare: (dir) => dir },
      { name: '超过字节上限', maxBytes: 1024, prepare: (dir) => writeFile(dir, 'big.pdf', new Uint8Array(4096)) },
    ];
    for (const item of cases) {
      const dir = tempDir();
      const io = await boot(item.maxBytes ?? 5_242_880);
      // 同步腿就同步抛（网关那一侧的 try 同样接得住），所以这里不用 `.catch` 而是就地捕获。
      let failure: unknown;
      try {
        io.bytes(item.prepare(dir));
      } catch (caught) {
        failure = caught;
      }
      expect(failure, item.name).toBeInstanceOf(AppError);
      expect((failure as AppError).code, item.name).toBe('PDF_EDIT_READ_FAILED');
      expect((failure as AppError).message).toMatch(/[\u4e00-\u9fa5]/);
    }
  });
});

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});
