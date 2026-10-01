/**
 * 生成轨打印装配层的用例（spec 3.3-03 / 3.3-05 / 3.3-07 / 3.3-09 的可单测半边；不含 Electron，纯函数）。
 *
 * 这里验的是「产物长什么样、读数对不对」，不是「真实内核打印跑不跑」——后者在 spike（`.research-repos/print-spike`）
 * 与 3.3 实现期的 shell 执行器里跑。把不碰 WebContents 的部分独立出来单测，正是 L2 不反向依赖 L1 的直接收益。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, makeField, RESUME_SCHEMA_VERSION, resumePrint, type ResumeDocument } from './index.js';

const FONT_BASE = 'file:///app/resources/fonts';

function doc(overrides: Partial<ResumeDocument> = {}): ResumeDocument {
  return {
    id: 'resume-1',
    schemaVersion: RESUME_SCHEMA_VERSION,
    profile: { name: '张三', contact: { email: 'z@x.com', phone: null, location: '上海' } },
    layout: DEFAULT_LAYOUT,
    sections: [
      {
        id: 'exp',
        kind: 'experience',
        title: '经历',
        entries: [
          {
            id: 'e1',
            fields: [makeField('experience', 'company', '星桥科技'), makeField('experience', 'role', '后端工程师')],
          },
        ],
      },
    ],
    metrics: { pages: 1 },
    updatedAt: 1234,
    ...overrides,
  };
}

describe('3.3-03 打印选项与版式全部取自模型，不散落魔法数', () => {
  it('toRequest 的 html 里 @page 尺寸/边距、字号、行距逐一对应 DEFAULT_LAYOUT', () => {
    const { html } = resumePrint.toRequest(doc(), 'classic', 'zh-CN', FONT_BASE);
    expect(html).toContain('@page{size:A4;margin:14mm 16mm 14mm 16mm;}');
    expect(html).toContain('font-size:10.5pt');
    expect(html).toContain('line-height:1.5');
  });

  it('改模型 layout 会同步改到打印 HTML（配置唯一来源是文档）', () => {
    const custom = doc({
      layout: {
        ...DEFAULT_LAYOUT,
        baseFontPt: 12,
        lineHeight: 1.2,
        margin: { topMm: 10, rightMm: 12, bottomMm: 10, leftMm: 12 },
      },
    });
    const { html } = resumePrint.toRequest(custom, 'classic', 'zh-CN', FONT_BASE);
    expect(html).toContain('@page{size:A4;margin:10mm 12mm 10mm 12mm;}');
    expect(html).toContain('font-size:12pt');
    expect(html).toContain('line-height:1.2');
  });

  it('options 走 preferCSSPageSize + 边距归零 + A4 + 打印背景，避免与 @page 双份边距', () => {
    const { options } = resumePrint.toRequest(doc(), 'classic', 'zh-CN', FONT_BASE);
    expect(options).toEqual({
      pageSize: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    });
  });
});

describe('3.3-05 随包内嵌字体在打印 HTML 里被声明', () => {
  it('四只 woff2（中文 400/700 + 拉丁 400/700）都以 base URL 拼接进 @font-face', () => {
    const { html } = resumePrint.toRequest(doc(), 'classic', 'zh-CN', FONT_BASE);
    for (const file of [
      'noto-sans-sc-chinese-simplified-400-normal.woff2',
      'noto-sans-sc-chinese-simplified-700-normal.woff2',
      'noto-sans-sc-latin-400-normal.woff2',
      'noto-sans-sc-latin-700-normal.woff2',
    ]) {
      expect(html).toContain(`${FONT_BASE}/${file}`);
    }
    expect(html).toContain("format('woff2')");
    // 拉丁档带 unicode-range，中文档不带。
    expect(html).toContain('unicode-range:U+0000-00FF;');
  });

  it('未知模板 id 直接抛可读错，不在打印层吞掉', () => {
    expect(() => resumePrint.buildHtml(doc(), 'ghost', 'zh-CN', FONT_BASE)).toThrow(/未知模板/);
  });

  it('同一 doc+模板+语言两次装配逐字节一致（不读时钟/随机）', () => {
    const a = resumePrint.buildHtml(doc(), 'classic', 'zh-CN', FONT_BASE);
    const b = resumePrint.buildHtml(doc(), 'classic', 'zh-CN', FONT_BASE);
    expect(a).toBe(b);
  });
});

describe('模板正文与语言贯穿到打印文档（服务 3.2 顺延的 en 导出腿）', () => {
  it('zh-CN 下 html lang 为 zh-CN，正文出现中文区块标签与数据', () => {
    const { html } = resumePrint.toRequest(doc(), 'classic', 'zh-CN', FONT_BASE);
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain('星桥科技');
    expect(html).toContain('后端工程师');
  });

  it('en 下 html lang 为 en，区块标签转英文而数据不变', () => {
    const { html } = resumePrint.toRequest(doc(), 'classic', 'en', FONT_BASE);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('Experience');
    expect(html).toContain('星桥科技');
  });
});

describe('3.3-07/09 对 printToPDF 产物的字节级结构读数', () => {
  it('识别 %PDF 头、按 /Type /Page 计数（不误计 /Type /Pages）、命中 FontFile 与 ToUnicode', () => {
    const fake = Buffer.from(
      '%PDF-1.4\n<< /Type /Pages /Count 2 >>\n<< /Type /Page >>\n<< /FontFile2 5 0 R >>\n<< /ToUnicode 9 0 R >>',
      'latin1',
    );
    const r = resumePrint.inspectPdf(fake);
    expect(r.isPdf).toBe(true);
    expect(r.pageCount).toBe(1);
    expect(r.hasEmbeddedFont).toBe(true);
    expect(r.hasTextLayer).toBe(true);
    expect(r.byteLength).toBe(fake.length);
  });

  it('非 PDF 输入不判成合法、页数为 0，不抛异常', () => {
    const r = resumePrint.inspectPdf(Buffer.from('not a pdf at all', 'latin1'));
    expect(r.isPdf).toBe(false);
    expect(r.pageCount).toBe(0);
    expect(r.hasEmbeddedFont).toBe(false);
  });

  it('多页产物按 /Type /Page 逐页计数', () => {
    const fake = Buffer.from('%PDF-1.4 /Type /Page /Type /Page /Type /Page', 'latin1');
    expect(resumePrint.inspectPdf(fake).pageCount).toBe(3);
  });
});
