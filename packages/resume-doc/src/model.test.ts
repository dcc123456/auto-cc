/**
 * 文档模型用例（spec 3.1-01 分层与默认值 / 3.1-04 缺失区块 / 3.1-07 空文档合法 A4 单页）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createEmptyDocument,
  DEFAULT_LAYOUT,
  factKeyOf,
  makeField,
  RESUME_SCHEMA_VERSION,
  type ResumeDocument,
  type Section,
} from './model.js';
import { validateDocument } from './schema.js';

/** 造一份带经历区块的样例文档，供各用例复用。 */
function sampleDoc(): ResumeDocument {
  const exp: Section = {
    id: 'exp',
    kind: 'experience',
    title: '工作经历',
    entries: [
      {
        id: 'e1',
        fields: [
          makeField('experience', 'company', '星桥科技'),
          makeField('experience', 'role', '前端工程师'),
          makeField('experience', 'period', '2021-2024'),
          makeField('experience', 'desc', '负责桌面端'),
        ],
      },
    ],
  };
  return {
    id: 'r1',
    schemaVersion: RESUME_SCHEMA_VERSION,
    profile: { name: '张三', contact: { email: 'z@example.com', phone: null, location: '上海' } },
    layout: DEFAULT_LAYOUT,
    sections: [exp],
    metrics: { pages: 1 },
    updatedAt: 1000,
  };
}

describe('3.1-01 分层与度量默认值', () => {
  it('文档→区块→条目→字段四层齐备，字段自带事实锁定标记', () => {
    const doc = sampleDoc();
    const section = doc.sections[0];
    expect(section?.kind).toBe('experience');
    const entry = section?.entries[0];
    expect(entry?.fields).toHaveLength(4);
    const company = entry?.fields.find((f) => f.key === 'company');
    expect(company?.locked).toBe(true);
    expect(company?.factKey).toBe('company');
    // desc 不属于四类事实，不锁定。
    expect(entry?.fields.find((f) => f.key === 'desc')?.locked).toBe(false);
  });

  it('DEFAULT_LAYOUT 是 A4 + 有边距/字号/行距/单栏的确定默认', () => {
    expect(DEFAULT_LAYOUT.pageSize).toBe('A4');
    expect(DEFAULT_LAYOUT.columns).toBe(1);
    expect(DEFAULT_LAYOUT.baseFontPt).toBeGreaterThan(0);
    expect(DEFAULT_LAYOUT.margin.topMm).toBeGreaterThanOrEqual(0);
  });
});

describe('3.1-04 缺失区块可渲染不报错', () => {
  it('只有 summary、没有 experience/education 的文档依然合法', () => {
    const doc: ResumeDocument = {
      ...sampleDoc(),
      sections: [
        {
          id: 'sum',
          kind: 'summary',
          title: '个人简介',
          entries: [{ id: 's1', fields: [{ key: 'text', value: '五年经验', locked: false, factKey: null }] }],
        },
      ],
    };
    const result = validateDocument(doc);
    expect(result.ok).toBe(true);
  });

  it('零区块文档也合法（缺失是常态，不是错误）', () => {
    expect(validateDocument(createEmptyDocument('x', 1)).ok).toBe(true);
  });
});

describe('3.1-07 空文档 = 合法 A4 单页起点', () => {
  it('createEmptyDocument 通过校验、无区块、布局为 A4、页数度量为 1', () => {
    const empty = createEmptyDocument('start', 2000);
    const result = validateDocument(empty);
    expect(result.ok).toBe(true);
    expect(empty.sections).toHaveLength(0);
    expect(empty.layout.pageSize).toBe('A4');
    expect(empty.metrics.pages).toBe(1);
  });
});

describe('factKeyOf 四类事实判定', () => {
  it('经历/项目/校园下四类键被锁，技能区块不锁事实', () => {
    expect(factKeyOf('experience', 'company')).toBe('company');
    expect(factKeyOf('project', 'achievement')).toBe('achievement');
    expect(factKeyOf('campus', 'period')).toBe('period');
    expect(factKeyOf('experience', 'desc')).toBeNull();
    expect(factKeyOf('skills', 'company')).toBeNull();
  });
});

describe('3.1-10 模型不含任何 HTML / 渲染细节', () => {
  it('本包全部源码里不出现标签字符串 / innerHTML / style 属性拼接', () => {
    // 从模块自身位置解析 src 目录，不依赖 vitest 的工作目录（此前用 '.' 扫到的是包根，没有 .ts，断言空转）。
    const srcDir = fileURLToPath(new URL('.', import.meta.url));
    const files = readdirSync(srcDir).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
    // 至少要真的扫到源码文件，否则「没命中」只是因为「没读到」。
    expect(files.length).toBeGreaterThan(0);
    // 只针对真实 HTML/DOM 痕迹：闭合标签、已知标签名、DOM API、带引号的 class/style。
    // 用闭合标签与标签名白名单而非泛泛的 `<x>`，否则会把 TS 泛型 `Map<string, Entry>` 误判成标签。
    const patterns = [
      /<\/[a-zA-Z]/,
      /<(div|span|p|img|br|a|table|tr|td|ul|li|ol|body|html|h[1-6]|section|header|footer|input|button)\b/,
      /innerHTML/,
      /createElement\(/,
      /\bclass\s*=\s*["']/,
      /\bstyle\s*=\s*["']/,
    ];
    for (const file of files) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      for (const pattern of patterns) {
        expect(pattern.test(source), `${file} 命中了渲染细节模式 ${String(pattern)}`).toBe(false);
      }
    }
  });
});
