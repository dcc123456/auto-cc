/**
 * 模板系统用例（spec 3.2-01 / 03 / 04 / 05 / 06 / 07 / 09 / 10）。
 *
 * 3.2 的 U/C 腿全部可在**无 UI、无打印**下断言——模板是纯函数，输出就是 HTML 字符串。
 * 唯一必须跑真打印的是 3.2-02/06/08 的「导出后逐页截图」（V），它们依赖 3.3 的 printToPDF 管线，显式顺延。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  makeField,
  resumeTemplate,
  TemplateBindingError,
  type ResumeDocument,
  type ResumeTemplate,
  type Section,
} from './index.js';
import { bindField, escapeHtml, fieldLabel, sectionLabel } from './internal/bind.js';

function doc(overrides: Partial<ResumeDocument> = {}): ResumeDocument {
  const experience: Section = {
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
  };
  const education: Section = {
    id: 'edu',
    kind: 'education',
    title: '教育背景',
    entries: [
      { id: 'g1', fields: [makeField('education', 'school', '示例大学'), makeField('education', 'major', '软件工程')] },
    ],
  };
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
    sections: [experience, education],
    metrics: { pages: 1 },
    updatedAt: 1,
    ...overrides,
  };
}

describe('3.2-01 模板是纯函数 render(doc)=>HTML', () => {
  it('同一 doc + 同一模板 + 同一语言 → 两次输出字节一致（无副作用 / 不读时钟不读随机）', () => {
    const a = resumeTemplate.render(doc(), 'classic', 'zh-CN');
    const b = resumeTemplate.render(doc(), 'classic', 'zh-CN');
    expect(a).toBe(b);
    expect(a.startsWith('<article')).toBe(true);
  });

  it('数据值出现在产物里（渲染的是文档内容，不是占位）', () => {
    const html = resumeTemplate.render(doc(), 'classic', 'zh-CN');
    expect(html).toContain('张三');
    expect(html).toContain('星桥科技');
    expect(html).toContain('前端工程师');
  });
});

describe('3.2-03 SPI：list / get / render，新增模板不改核心', () => {
  it('内置 ≥3 套模板且 id 齐全', () => {
    const ids = resumeTemplate.list().map((t) => t.id);
    expect(ids.length).toBeGreaterThanOrEqual(3);
    expect(ids).toEqual(expect.arrayContaining(['classic', 'modern', 'minimal']));
  });

  it('get 命中返回模板，未知 id 返回 null（不抛裸异常）', () => {
    expect(resumeTemplate.get('classic')?.id).toBe('classic');
    expect(resumeTemplate.get('不存在')).toBeNull();
  });

  it('render 未知 id 抛出可读错误（列出可用 id）', () => {
    expect(() => resumeTemplate.render(doc(), 'ghost')).toThrow(/未知模板：ghost/);
  });

  it('运行期 register 一套新模板后 list 立即含它、render 可用——list/get/render 源码未改', () => {
    const smoke: ResumeTemplate = {
      id: 'smoke-新增',
      name: '冒烟',
      origin: 'clean-room-rewrite',
      // 契约要求现场交代版面取值：注册表里那一份 `spec` 同时是渲染实参与界面骨架小图的唯一依据（spec 6.4-09）。
      spec: {
        columns: 2,
        accent: 'teal',
        header: 'boxed',
        heading: 'pill',
        entry: 'split',
        density: 'compact',
        serif: true,
        nameSize: '4xl',
        nameWeight: 'black',
        nameCaps: true,
        contactSep: ' | ',
        entryDivider: true,
        plainGrid: true,
      },
      render: (d: ResumeDocument, ctx) => `<i data-locale="${ctx.locale}">${d.profile.name}</i>`,
    };
    resumeTemplate.register(smoke);
    expect(resumeTemplate.list().map((t) => t.id)).toContain('smoke-新增');
    expect(resumeTemplate.render(doc(), 'smoke-新增', 'en')).toBe('<i data-locale="en">张三</i>');
    // 同 id 再注册必须被拒，杜绝静默覆盖。
    expect(() => resumeTemplate.register(smoke)).toThrow(/模板 id 重复/);
  });
});

describe('3.2-04 数据绑定错误可定位（区块 + 字段名）', () => {
  const missingRole = (): ResumeDocument => {
    const exp = doc().sections.find((s) => s.kind === 'experience')!;
    exp.entries[0]!.fields = exp.entries[0]!.fields.filter((f) => f.key !== 'role');
    return { ...doc(), sections: [exp, doc().sections[1]!] };
  };

  for (const id of ['classic', 'modern', 'minimal']) {
    it(`${id}：核心槽位（职位）缺失 → 抛 TemplateBindingError，指明区块与字段`, () => {
      try {
        resumeTemplate.render(missingRole(), id);
        expect.unreachable('应当抛错');
      } catch (error) {
        expect(error).toBeInstanceOf(TemplateBindingError);
        const bind = error as TemplateBindingError;
        expect(bind.sectionKind).toBe('experience');
        expect(bind.fieldKey).toBe('role');
        expect(bind.message).toContain('工作经历'); // 区块标签本地化
        expect(bind.message).toContain('role'); // 字段键定位
      }
    });
  }

  it('可选字段（电话）缺失不抛错，只跳过', () => {
    expect(() => resumeTemplate.render(doc(), 'minimal', 'zh-CN')).not.toThrow();
  });
});

describe('3.2-05 / 3.2-06 模板只排版不加工数据、文案全走 i18n', () => {
  const templatesSrc = readFileSync(fileURLToPath(new URL('./internal/templates.ts', import.meta.url)), 'utf8');
  const bindSrc = readFileSync(fileURLToPath(new URL('./internal/bind.ts', import.meta.url)), 'utf8');

  it('模板源码里不出现截断 / 数值推断 / 时间格式化等业务加工函数（3.2-05）', () => {
    for (const forbidden of [
      '.slice(',
      '.substring(',
      '.substr(',
      'Math.',
      'new Date',
      'toFixed(',
      'parseInt',
      'parseFloat',
    ]) {
      expect(templatesSrc, `模板不应包含业务加工：${forbidden}`).not.toContain(forbidden);
    }
  });

  it('模板源码不硬编码中文区块标签——标签只来自 bind.ts 的 i18n 表（3.2-06）', () => {
    for (const label of ['工作经历', '教育背景', '专业技能', '个人简介']) {
      expect(templatesSrc, `模板不该写死标签：${label}`).not.toContain(label);
    }
    // 标签确实集中在 i18n 表里。
    expect(bindSrc).toContain('工作经历');
  });

  it('zh-CN 与 en 切语言：标签变、数据不变', () => {
    const zh = resumeTemplate.render(doc(), 'classic', 'zh-CN');
    const en = resumeTemplate.render(doc(), 'classic', 'en');
    expect(zh).toContain('工作经历');
    expect(en).toContain('Experience');
    expect(en).toContain('星桥科技'); // 数据不随语言变
    expect(en).toContain('Email:');
    expect(sectionLabel('experience', 'en')).toBe('Experience');
    expect(fieldLabel('company', 'zh-CN')).toBe('公司');
  });
});

describe('3.2-07 生成轨 HTML 只用 Tailwind utility，不写自定义 CSS', () => {
  for (const id of ['classic', 'modern', 'minimal']) {
    it(`${id} 产物无 <style> / 无内联 style= / 有 class=`, () => {
      const html = resumeTemplate.render(doc(), id);
      expect(html).not.toContain('<style');
      expect(html).not.toContain('style="');
      expect(html).toContain('class="');
    });
  }

  it('模板与基元源码都不 import 任何 .css 文件', () => {
    for (const file of ['./internal/templates.ts', './internal/bind.ts', './template.ts']) {
      const src = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
      expect(src, `${file} 不该引样式文件`).not.toMatch(/\.css['"]/);
    }
  });
});

describe('3.2-09 超长条目不截断（U 腿：内容完整；页数增长属 V 交 3.3）', () => {
  it('5000 字成果原样出现在产物里，且所有条目都渲染出来了', () => {
    const long = '经'.repeat(5000);
    const d = doc();
    const exp = d.sections.find((s) => s.kind === 'experience')!;
    exp.entries[0]!.fields.find((f) => f.key === 'achievement')!.value = long;
    exp.entries.push({
      id: 'e2',
      fields: [makeField('experience', 'company', '第二家公司'), makeField('experience', 'role', '架构师')],
    });
    const html = resumeTemplate.render(d, 'classic');
    expect(html).toContain(escapeHtml(long)); // 未截断
    expect(html).toContain('第二家公司'); // 未丢条目
    expect(html.match(/星桥科技/g)?.length).toBe(1); // 未重复
  });
});

describe('安全：数据值 HTML 转义（注入面在打印视图，必须封）', () => {
  it('字段里的 <script> 被转义为文本，不作为标签出现', () => {
    const d = doc();
    const exp = d.sections.find((s) => s.kind === 'experience')!;
    exp.entries[0]!.fields.find((f) => f.key === 'achievement')!.value = '<script>alert(1)</script>';
    const html = resumeTemplate.render(d, 'classic');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('空文档（无区块）也能渲染不抛错', () => {
    const empty = doc({ sections: [], profile: { name: '', contact: { email: null, phone: null, location: null } } });
    for (const id of ['classic', 'modern', 'minimal']) {
      expect(() => resumeTemplate.render(empty, id)).not.toThrow();
    }
  });
});

describe('3.2-10 抽取来源记录：全部 clean-room 重写，未搬 ai-resume 代码', () => {
  it('每套模板 origin 标记为重写，且许可门禁未被本包触发', () => {
    for (const t of resumeTemplate.list()) {
      expect(t.origin).toBe('clean-room-rewrite');
    }
    const templatesSrc = readFileSync(fileURLToPath(new URL('./internal/templates.ts', import.meta.url)), 'utf8');
    expect(templatesSrc).toContain('clean-room');
    // bindField 缺失即抛错的语义也在此回归一次（被模板共用）。
    const section = doc().sections.find((s) => s.kind === 'experience')!;
    expect(() => bindField('classic', section, section.entries[0]!, 'ghostKey', 'zh-CN')).toThrow(TemplateBindingError);
  });
});
