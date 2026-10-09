/**
 * 模板库与打印样式表的机检（spec 3.2-02 / 3.2-03 / 3.2-07 的判据半边）。
 *
 * 这三条断言存在的理由是本项目 3.2-02 那条"三套模板像素相同"的告警**真正的成因**：
 * 模板按 3.2-07 只用 Tailwind utility class 表达版面，而打印 HTML 是一份自足文档，
 * 过去它内联的样式表里根本没有这些 class 的规则——于是 class 全是空转，四道门禁却全绿。
 * 所以这里守的正是那三个当时没人守的口子：class 必须有规则、模板之间必须真的不一样、数量必须够。
 */
import { describe, expect, it } from 'vitest';
import { createEmptyDocument, makeField, type ResumeDocument, type Section } from './model.js';
import { buildPrintHtml } from './internal/print-html.js';
import { PRINT_UTILITY_KEYS } from './internal/print-css.js';
import { BUILTIN_TEMPLATES } from './internal/templates.js';
import { resumeTemplate } from './template.js';

/** baseRule / resetRule / breakRule 里已经带上或不需要规则的类名（不属于 utility 表）。 */
const NON_UTILITY_CLASSES = new Set(['resume-entry']);

/** 造一份覆盖全部区块种类、且每栏都有内容的文档（双栏模板要同时有侧栏与主栏数据）。 */
function fullDocument(): ResumeDocument {
  const sections: Section[] = [
    {
      id: 'summary',
      kind: 'summary',
      title: '个人简介',
      entries: [{ id: 's1', fields: [makeField('summary', 'text', '五年后端工程师。')] }],
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
            makeField('experience', 'role', '后端工程师'),
            makeField('experience', 'period', '2021 - 2024'),
            makeField('experience', 'achievement', '订单服务重构，P99 下降 40%。'),
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
          id: 'd1',
          fields: [
            makeField('education', 'school', '未名大学'),
            makeField('education', 'degree', '本科'),
            makeField('education', 'period', '2017 - 2021'),
          ],
        },
      ],
    },
    {
      id: 'skills',
      kind: 'skills',
      title: '技能',
      entries: [{ id: 'k1', fields: [makeField('skills', 'text', 'TypeScript / Electron')] }],
    },
    {
      id: 'project',
      kind: 'project',
      title: '项目经历',
      entries: [
        { id: 'p1', fields: [makeField('project', 'company', '开源社区'), makeField('project', 'role', '维护者')] },
      ],
    },
    {
      id: 'campus',
      kind: 'campus',
      title: '校园经历',
      entries: [{ id: 'c1', fields: [makeField('campus', 'company', '学生会'), makeField('campus', 'role', '干事')] }],
    },
  ];
  return {
    ...createEmptyDocument('resume-lib', Date.now()),
    profile: { name: '张三', contact: { email: 'a@example.com', phone: '13800000000', location: '上海' } },
    sections,
  };
}

/**
 * 从渲染产物里取出所有 class 令牌。
 * @param html 模板渲染出的 HTML 片段
 * @returns 出现过的 class 名集合
 */
function classTokens(html: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of html.matchAll(/class="([^"]*)"/g)) {
    for (const token of (match[1] ?? '').split(/\s+/)) {
      if (token !== '') tokens.add(token);
    }
  }
  return tokens;
}

describe('内置模板库（3.2-02 / 3.2-03）', () => {
  it('注册表里至少 50 套，且 id 与展示名各自唯一', () => {
    expect(BUILTIN_TEMPLATES.length).toBeGreaterThanOrEqual(50);
    expect(resumeTemplate.list().length).toBe(BUILTIN_TEMPLATES.length);
    const ids = new Set(BUILTIN_TEMPLATES.map((item) => item.id));
    const names = new Set(BUILTIN_TEMPLATES.map((item) => item.name));
    expect(ids.size).toBe(BUILTIN_TEMPLATES.length);
    expect(names.size).toBe(BUILTIN_TEMPLATES.length);
  });

  it('3.2 落地的原三套 id 仍在（快照行的 template_id 引用不得被改名打断）', () => {
    for (const id of ['classic', 'modern', 'minimal']) {
      expect(resumeTemplate.get(id)?.id).toBe(id);
    }
  });

  it('每套模板对同一份文档渲染出的 HTML 互不相同（版面差异必须真实存在，不只是名字不同）', () => {
    const doc = fullDocument();
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const template of resumeTemplate.list()) {
      const html = template.render(doc, { locale: 'zh-CN' });
      const previous = seen.get(html);
      if (previous !== undefined) collisions.push(`${previous} 与 ${template.id}`);
      seen.set(html, template.id);
    }
    expect(collisions).toEqual([]);
  });

  it('每一套都能渲染 zh-CN 与 en 两种语言且不吞数据（六个区块的标题都出现在产物里）', () => {
    const doc = fullDocument();
    for (const template of resumeTemplate.list()) {
      for (const locale of ['zh-CN', 'en'] as const) {
        const html = template.render(doc, { locale });
        expect(html).toContain('张三');
        expect(html).toContain('星桥科技');
        expect(html).toContain('未名大学');
        expect(html).toContain('学生会');
      }
    }
  });

  it('模板产物里的每一个 class 都能在打印样式表里找到规则（class 空转即失败）', () => {
    const doc = fullDocument();
    const missing: string[] = [];
    for (const template of resumeTemplate.list()) {
      for (const token of classTokens(template.render(doc, { locale: 'zh-CN' }))) {
        if (NON_UTILITY_CLASSES.has(token)) continue;
        if (!PRINT_UTILITY_KEYS.has(token)) missing.push(`${template.id} → ${token}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('打印 HTML 内联了工具类样式表（缺它时所有模板导出像素相同——这条就是那次缺陷的护栏）', () => {
    const html = buildPrintHtml(fullDocument(), 'executive-amber', 'zh-CN', 'file:///fonts');
    expect(html).toContain('.text-4xl{');
    expect(html).toContain('.border-b{');
    expect(html).toContain('.bg-amber-800{');
  });
});
