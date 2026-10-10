/**
 * 样式层用例（spec 6.6-01 / 6.6-02）。
 *
 * 这一层是"用户能不能自己改颜色/字号/段落"的那一半，全部判据都能在**无 UI、无打印**下断言：
 * 模型腿走 Schema 与归一化，渲染腿走模板片段与 `resumePrint.buildHtml` 的产物字符串。
 * 像素级"改完真看起来不一样"是 V 类，落在 6.6-05 界面到货之后的活体那一步。
 *
 * 三条最要紧的判据各对应一次真实失手形状：
 * ① 「类挂上了但变量没发出去」——产物里就是静默回到模板默认值（所以有一条把片段里的每个 `rz-*` 反查回 `:root`）；
 * ② 「没设的轴也挂了一个读空变量的类」——CSS 在变量未定义时按 `unset` 处理，等于悄悄变黑，一条都不许多挂；
 * ③ 「样式层被当成改事实」——`checkFactLock` 只比 sections/entries/fields，这里钉住它不因主题而报违规。
 */
import { describe, expect, it } from 'vitest';
import {
  checkFactLock,
  contentHash,
  makeField,
  normalizeDocument,
  resumePrint,
  resumeTemplate,
  validateDocument,
  type DocumentDesign,
  type ResumeDocument,
  type Section,
} from './index.js';
import { DESIGN_SLOT_RULES, headingClassFor, rowClassesFor } from './internal/design-slots.js';
import { PARAGRAPH_KIND_ORDER, PARAGRAPH_STYLE_KEYS } from './normalize.js';
import { PRINT_STYLESHEET, PRINT_UTILITY_KEYS } from './internal/print-css.js';

const FONT_BASE = 'file:///app/resources/fonts';

/** 六类区块各一条条目：段落样式按种类寻址，夹具必须把六类都长出来才测得到"只设了一类"。 */
function doc(design?: DocumentDesign): ResumeDocument {
  const sections: Section[] = [
    {
      id: 'sum',
      kind: 'summary',
      title: '个人简介',
      entries: [{ id: 's1', fields: [makeField('summary', 'text', '八年前端，带过五人小组。')] }],
    },
    {
      id: 'exp',
      kind: 'experience',
      title: '工作经历',
      entries: [
        {
          id: 'e1',
          fields: [
            makeField('experience', 'company', '星桥科技'),
            makeField('experience', 'role', '前端工程师'),
            makeField('experience', 'period', '2021—2024'),
            makeField('experience', 'achievement', '把首屏从 3.2s 优化到 0.8s'),
          ],
        },
      ],
    },
    {
      id: 'edu',
      kind: 'education',
      title: '教育背景',
      entries: [
        {
          id: 'g1',
          fields: [makeField('education', 'school', '示例大学'), makeField('education', 'major', '软件工程')],
        },
      ],
    },
    {
      id: 'ski',
      kind: 'skills',
      title: '专业技能',
      entries: [{ id: 'k1', fields: [makeField('skills', 'skill', 'TypeScript')] }],
    },
    {
      id: 'prj',
      kind: 'project',
      title: '项目经历',
      entries: [
        {
          id: 'p1',
          fields: [makeField('project', 'company', '内部工作台'), makeField('project', 'role', '负责人')],
        },
      ],
    },
    {
      id: 'cap',
      kind: 'campus',
      title: '校园经历',
      entries: [
        { id: 'c1', fields: [makeField('campus', 'company', '计算机协会'), makeField('campus', 'role', '会长')] },
      ],
    },
  ];
  const styled = withDesign(baseDoc(sections), design);
  return styled;
}

/** 一份无主题的最小合法文档（`layout` 里根本不出现 `design` 键）。 */
function baseDoc(sections: Section[]): ResumeDocument {
  return {
    id: 'r1',
    schemaVersion: 1,
    profile: { name: '张三', contact: { email: 'z@x.com', phone: null, location: '上海' } },
    layout: {
      pageSize: 'A4',
      margin: { topMm: 14, rightMm: 16, bottomMm: 14, leftMm: 16 },
      baseFontPt: 10.5,
      lineHeight: 1.5,
      columns: 1,
    },
    sections,
    metrics: { pages: 1 },
    updatedAt: 1,
  };
}

/** 把主题挂到 `layout.design` 上（缺省 = 原样返回，用于"无主题"那一支对照）。 */
function withDesign(document: ResumeDocument, design?: DocumentDesign): ResumeDocument {
  if (!design) return document;
  return { ...document, layout: { ...document.layout, design } };
}

/** 取产物 `<style>` 里的 `:root` 那一块（样式层唯一允许出现用户颜色的地方）。 */
function rootBlock(html: string): string {
  const match = /:root\{[^}]*\}/.exec(html);
  return match === null ? '' : match[0];
}

describe('6.6-01 主题进得了模型：Schema 认它、也只认这一种颜色形状', () => {
  it('带主题的文档过权威校验，且主题原样留在 layout 上', () => {
    const result = validateDocument(doc({ inkHex: '#101820', accentHex: '#A31621' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.layout.design?.inkHex).toBe('#101820');
    expect(result.document.layout.design?.accentHex).toBe('#A31621');
  });

  it('没有主题的文档照样合法（这一层是可选的，旧库里的行不能突然非法）', () => {
    const result = validateDocument(doc());
    expect(result.ok).toBe(true);
    expect('design' in (result.ok ? result.document.layout : {})).toBe(false);
  });

  it('非 #rrggbb 的颜色被拒，且错误定位到那一条轴', () => {
    for (const bad of ['red', '#fff', '#12345', '#1018200']) {
      const result = validateDocument(doc({ inkHex: bad }));
      expect(result.ok, `${bad} 本该被拒`).toBe(false);
      if (result.ok) continue;
      expect(result.issues.map((issue) => issue.path).join(',')).toContain('layout.design.inkHex');
    }
  });

  it('未知键仍被 strictObject 拒掉（样式层没给"多塞一格"留口子）', () => {
    const raw = { ...doc({ inkHex: '#101820' }) };
    (raw.layout.design as Record<string, unknown>)['fontSizePx'] = 13;
    const result = validateDocument(raw);
    expect(result.ok).toBe(false);
  });
});

describe('6.6-01 归一化：主题参与内容 hash，空壳一律不出现', () => {
  it('同一主题换个键序与大小写 → 规范形一致、hash 相同', () => {
    const a = doc({ paragraphs: { experience: { inkHex: '#AA0000', sizePt: 12 } }, accentHex: '#112233' });
    const b = doc({ accentHex: '#112233', paragraphs: { experience: { sizePt: 12, inkHex: '#aa0000' } } });
    expect(contentHash(a)).toBe(contentHash(b));
    expect(normalizeDocument(a).layout.design?.paragraphs?.experience?.inkHex).toBe('#aa0000');
  });

  it('空壳主题（{} / 只有一格空段落）归一化后整个 design 键消失', () => {
    for (const shell of [{}, { paragraphs: { summary: {} } }, { body: {} }] as DocumentDesign[]) {
      const normalized = normalizeDocument(doc(shell));
      expect('design' in normalized.layout, JSON.stringify(shell)).toBe(false);
    }
  });

  it('改主题 = 改内容（快照与 diff 要能看见这一笔）', () => {
    expect(contentHash(doc({ inkHex: '#101820' }))).not.toBe(contentHash(doc()));
  });

  it('规范序两张表同源：段落 kinds 与轴 key 的清单互不重复登记', () => {
    // 六个种类 × 六条轴是样式层的全部寻址面；normalize 拥有清单，design-slots 只按清单铺槽位。
    expect(PARAGRAPH_KIND_ORDER).toHaveLength(6);
    expect(PARAGRAPH_STYLE_KEYS).toHaveLength(6);
    const slotClasses = DESIGN_SLOT_RULES.map((slot) => slot.className);
    expect(new Set(slotClasses).size).toBe(slotClasses.length);
    for (const kind of PARAGRAPH_KIND_ORDER) {
      // 每一类区块都必须拿到"全部六条轴各一只槽"，少一只就是那一格样式在产物里没落脚处。
      const perKind = slotClasses.filter((name) => name.startsWith(`rz-${kind}-`));
      expect(perKind, `rz-${kind}-* 缺槽`).toHaveLength(PARAGRAPH_STYLE_KEYS.length);
    }
  });
});

describe('6.6-01 样式不碰事实：只改主题的生成结果不算篡改', () => {
  it('checkFactLock 对"内容一字未动、只有 design 不同"的两份文档报零违规', () => {
    const original = doc();
    const styled = doc({ inkHex: '#101820', paragraphs: { experience: { align: 'justify' } } });
    expect(checkFactLock(original, styled)).toEqual([]);
  });
});

describe('6.6-02 模板片段：只挂设了的那几条轴的槽位类', () => {
  it('无主题时片段里一个 rz- 类都没有', () => {
    for (const template of resumeTemplate.list()) {
      expect(resumeTemplate.render(doc(), template.id, 'zh-CN')).not.toContain('rz-');
    }
  });

  it('设了 工作经历字号 + 简介底色 → 片段里只出现这两只类', () => {
    const html = resumeTemplate.render(
      doc({ paragraphs: { experience: { sizePt: 12 }, summary: { backdropHex: '#eef2ff' } } }),
      'classic',
      'zh-CN',
    );
    expect(html).toContain('rz-experience-size');
    expect(html).toContain('rz-summary-band');
    // 没设的轴不许顺手挂上（读了不存在的变量就是"计算值非法"，颜色会静默变黑）。
    for (const className of DESIGN_SLOT_RULES.map((slot) => slot.className)) {
      if (className === 'rz-experience-size' || className === 'rz-summary-band') continue;
      expect(html, `多挂了 ${className}`).not.toContain(className);
    }
  });

  it('文档级正文字号/字重/墨色各挂各的，段落级同轴时段落级独占', () => {
    const onlyBody = resumeTemplate.render(
      doc({ body: { sizePt: 11, weight: 'medium' }, inkHex: '#101820' }),
      'classic',
      'zh-CN',
    );
    expect(onlyBody).toContain('rz-body-size');
    expect(onlyBody).toContain('rz-body-weight');
    expect(onlyBody).toContain('rz-ink');
    expect(onlyBody).toContain('rz-design');
    const both = resumeTemplate.render(
      doc({ body: { sizePt: 11 }, inkHex: '#101820', paragraphs: { experience: { sizePt: 13, inkHex: '#aa0000' } } }),
      'classic',
      'zh-CN',
    );
    // 经历那一格由段落级接管，正文级那两只不许再挂上去争一次。
    const experienceRow = /<div class="text-\[13px\] font-bold[^"]*rz-experience-size[^"]*">/.exec(both);
    expect(experienceRow?.[0]).toBeDefined();
    expect(experienceRow?.[0]).not.toContain('rz-body-size');
    expect(experienceRow?.[0]).not.toContain('rz-ink');
  });

  it('强调色挂在区块标题上，pill 那一支豁免（色块上的反白字换成强调色等于隐形）', () => {
    const accented = resumeTemplate.render(doc({ accentHex: '#a31621' }), 'classic', 'zh-CN');
    expect(accented).toContain('rz-head');
    const pill = resumeTemplate.render(doc({ accentHex: '#a31621' }), 'designer-portfolio', 'zh-CN');
    expect(pill).not.toContain('rz-head');
    expect(headingClassFor({ accentHex: '#a31621' }, true)).toBe('');
    expect(headingClassFor(undefined, false)).toBe('');
  });

  it('正文字族覆盖模板的 serif 轴，未设时逐字随模板', () => {
    expect(resumeTemplate.render(doc(), 'classic', 'zh-CN')).toContain('<article class="font-serif');
    expect(resumeTemplate.render(doc({ body: { fontFamily: 'sans' } }), 'classic', 'zh-CN')).toContain(
      '<article class="font-sans',
    );
  });

  it('片段里绝不出现颜色字面量（hex 只在产物的文档级那一块）', () => {
    const html = resumeTemplate.render(doc({ inkHex: '#101820', paperHex: '#f7f5f2' }), 'classic', 'zh-CN');
    expect(/#[0-9a-fA-F]{6}/.test(html)).toBe(false);
    expect(html).not.toContain('style="');
  });
});

describe('6.6-02 产物文档：类与变量同源，且槽位规则排在 utility 之后', () => {
  it('无主题时产物里没有 :root 块，也没有纸底色那条规则', () => {
    // 静态槽位规则本身恒定存在（它们只是读变量的壳），所以判据是"变量没被赋值、body 不铺色"，
    // 而不是"全文看不见 --rz-"。
    const html = resumePrint.buildHtml(doc(), 'classic', 'zh-CN', FONT_BASE);
    expect(html).not.toContain(':root{');
    expect(html).not.toContain('background-color:var(--rz-paper)');
  });

  it('片段里挂上的每一只 rz- 类，都能在 :root 里找到它读的那只变量', () => {
    const document = doc({
      inkHex: '#101820',
      paperHex: '#f7f5f2',
      accentHex: '#a31621',
      body: { sizePt: 11, weight: 'bold' },
      paragraphs: { experience: { sizePt: 12, inkHex: '#aa0000' }, skills: { backdropHex: '#0b5c50' } },
    });
    const html = resumePrint.buildHtml(document, 'modern', 'zh-CN', FONT_BASE);
    const root = rootBlock(html);
    const fragment = resumeTemplate.render(document, 'modern', 'zh-CN');
    const used = DESIGN_SLOT_RULES.filter((slot) => fragment.includes(slot.className));
    expect(used.length).toBeGreaterThan(0);
    for (const slot of used) {
      expect(root, `${slot.className} 读了没有值的变量`).toContain(slot.varName);
    }
    // 纸底没有类槽，只有一条 body 规则；它同样只能读变量，不许把 hex 抄第二遍。
    expect(root).toContain('--rz-paper:#f7f5f2;');
    expect(html).toContain('body{background-color:var(--rz-paper);}');
    // 反向的一半：**用户选中的那些颜色字面量只许出现在文档级那一块里**。
    // 样式表里的 Tailwind 色板也含 hex，但那不是用户给的值，所以判据按值逐个查、且只在剔掉 :root 块之后查。
    for (const hex of ['#101820', '#f7f5f2', '#a31621', '#aa0000', '#0b5c50']) {
      expect(html.replace(root, ''), `${hex} 漏到了文档级之外`).not.toContain(hex);
    }
  });

  it('槽位规则全量登记进打印样式表，且排在全部 utility 之后（同特异度时后出现者胜）', () => {
    for (const slot of DESIGN_SLOT_RULES) {
      expect(PRINT_UTILITY_KEYS.has(slot.className), slot.className).toBe(true);
      expect(PRINT_STYLESHEET).toContain(`.${slot.className}{${slot.declaration};}`);
    }
    const html = resumePrint.buildHtml(doc({ inkHex: '#101820' }), 'classic', 'zh-CN', FONT_BASE);
    // 模板自带的 `text-neutral-700` 与 `rz-ink` 都是 0,1,0：谁在样式表里更靠后谁赢，这一条顺序就是"用户赢"。
    expect(html.indexOf('.text-neutral-700{')).toBeLessThan(html.indexOf('.rz-ink{'));
    expect(html.indexOf('.rz-ink{')).toBeLessThan(html.indexOf(':root{'));
  });

  it('rowClassesFor 对无主题文档一律空串（界面上"没选"与"选了模板默认值"在产物里同一件事）', () => {
    for (const kind of PARAGRAPH_KIND_ORDER) {
      expect(rowClassesFor(undefined, kind)).toBe('');
    }
  });
});
