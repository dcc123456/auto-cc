/**
 * 生成轨打印装配层的用例（spec 3.3-03 / 3.3-05 / 3.3-07 / 3.3-09 的可单测半边；不含 Electron，纯函数）。
 *
 * 这里验的是「产物长什么样、读数对不对」，不是「真实内核打印跑不跑」——后者在 spike（`.research-repos/print-spike`）
 * 与 3.3 实现期的 shell 执行器里跑。把不碰 WebContents 的部分独立出来单测，正是 L2 不反向依赖 L1 的直接收益。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, makeField, RESUME_SCHEMA_VERSION, resumePrint, type ResumeDocument } from './index.js';
import { PRINT_STYLESHEET } from './internal/print-css.js';

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

  it('6.6-03 屏幕上的那一份自己吃下同一份边距，打印那一支显式归零（屏上贴纸边而产物有边是两条纸）', () => {
    const { html } = resumePrint.toRequest(doc(), 'classic', 'zh-CN', FONT_BASE);
    expect(html).toContain('@media screen{body{padding:14mm 16mm 14mm 16mm;}}');
    expect(html).toContain('@media print{body{padding:0;}}');
  });

  it('6.6-03 屏上边距与 @page 同源：改模型 margin 两处一起变，不出现第二个数', () => {
    const custom = doc({
      layout: { ...DEFAULT_LAYOUT, margin: { topMm: 20, rightMm: 8, bottomMm: 20, leftMm: 8 } },
    });
    const { html } = resumePrint.toRequest(custom, 'classic', 'zh-CN', FONT_BASE);
    expect(html).toContain('@page{size:A4;margin:20mm 8mm 20mm 8mm;}');
    expect(html).toContain('@media screen{body{padding:20mm 8mm 20mm 8mm;}}');
  });
});

describe('3.3-05 随包内嵌字体在打印 HTML 里被声明', () => {
  it('正体那四只 woff2（中文 400/700 + 拉丁 400/700）都以 base URL 拼接进 @font-face', () => {
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

  it('6.6-04 衬线档以自己的族名声明：11 套 serif 模板的中文不再静默掉回系统衬线', () => {
    const { html } = resumePrint.toRequest(doc(), 'classic', 'zh-CN', FONT_BASE);
    for (const file of [
      'noto-serif-sc-chinese-simplified-400-normal.woff2',
      'noto-serif-sc-chinese-simplified-700-normal.woff2',
      'noto-serif-sc-latin-400-normal.woff2',
      'noto-serif-sc-latin-700-normal.woff2',
    ]) {
      expect(html).toContain(`${FONT_BASE}/${file}`);
    }
    // 中文主体档不带 unicode-range、拉丁档带：两族各自的四档都是这个形状。
    for (const face of [
      "@font-face{font-family:'Noto Serif SC';font-weight:700;font-style:normal;src:",
      "@font-face{font-family:'Noto Serif SC';font-weight:400;font-style:normal;unicode-range:U+0000-00FF;src:",
    ]) {
      expect(html).toContain(face);
    }
  });

  it('6.6-04 样式表里 font-sans / font-serif 各自认领一个随包族名（拼错一个就静默掉回系统字体）', () => {
    const { html } = resumePrint.toRequest(doc(), 'classic', 'zh-CN', FONT_BASE);
    const declared = new Set([...html.matchAll(/@font-face\{font-family:'([^']+)'/g)].map((face) => face[1]));
    expect([...declared]).toEqual(['Noto Sans SC', 'Noto Serif SC']);
    // 系统字体（Georgia / Times New Roman）留在字族栈里是**有意的**：拉丁走它们，中文只认随包那一族。
    // 所以判据不是"栈里每个名字都随包"，而是"这一条 utility 里有一个名字随包"——否则衬线模板的中文就没人认领了，
    // 而那正是这条报障里「这套模板看起来没做完整」的来源（spec 6.6-04）。
    expect(PRINT_STYLESHEET).toMatch(/font-sans\{font-family:[^}]*Noto Sans SC[^}]*\}/);
    expect(PRINT_STYLESHEET).toMatch(/font-serif\{font-family:[^}]*Noto Serif SC[^}]*\}/);
  });

  it('字体集标识含两族八档，快照据此认得出是哪一份字体产的产物', () => {
    expect(resumePrint.fontSet).toContain('Noto Sans SC');
    expect(resumePrint.fontSet).toContain('Noto Serif SC');
    expect(resumePrint.fontSet.split(',')).toHaveLength(8);
  });

  it('同一 doc+模板+语言两次装配逐字节一致（不读时钟/随机）', () => {
    const a = resumePrint.buildHtml(doc(), 'classic', 'zh-CN', FONT_BASE);
    const b = resumePrint.buildHtml(doc(), 'classic', 'zh-CN', FONT_BASE);
    expect(a).toBe(b);
  });
});

describe('3.3-08 分页护栏：条目整体不跨页、区块标题不成孤儿', () => {
  it('打印 HTML 里带 break-inside:avoid（护条目）与 h2 的 break-after:avoid（护标题）', () => {
    const { html } = resumePrint.toRequest(doc(), 'classic', 'zh-CN', FONT_BASE);
    expect(html).toContain('.resume-entry{break-inside:avoid;}');
    expect(html).toContain('h2{break-after:avoid;}');
  });

  it('每个条目的包裹 div 都带 resume-entry 类（护栏规则命中的选择器）', () => {
    const { html } = resumePrint.toRequest(doc(), 'classic', 'zh-CN', FONT_BASE);
    expect(html).toContain('class="resume-entry');
  });
});

describe('自由正文条目不印出键名（summary/skills 的 text 字段无标签）', () => {
  it('summary 里的 text 字段渲染出正文而非字面量 "text" 标签', () => {
    const withSummary = doc({
      sections: [
        {
          id: 'sum',
          kind: 'summary',
          title: '个人简介',
          entries: [{ id: 's1', fields: [makeField('summary', 'text', '十年后端工程师')] }],
        },
      ],
    });
    const { html } = resumePrint.toRequest(withSummary, 'classic', 'zh-CN', FONT_BASE);
    expect(html).toContain('十年后端工程师');
    expect(html).not.toContain('>text<');
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
