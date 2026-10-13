/**
 * 模板系统用例（spec 3.2-01 / 03 / 04 / 05 / 06 / 07 / 09 / 10）。
 *
 * 3.2 的 U/C 那一条全部可在**无 UI、无打印**下断言——模板是纯函数，输出就是 HTML 字符串。
 * 唯一必须跑真打印的是 3.2-02/06/08 的「导出后逐页截图」（V），它们依赖 3.3 的 printToPDF 管线，显式顺延。
 */
import { createHash } from 'node:crypto';
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

/**
 * 锚点整串删掉 = "没有锚点的那一份"，用来量锚点到底多带了什么（3.10-02 的三枚 + 3.11-04 的打字两枚）。
 * 提到 describe 外面是因为 3.2-09 那条"没重复渲染"也要用它：`data-rz-raw` 里本来就带着同一份原文，
 * 不剥锚点就会把"纸面上出现一次"数成两次。
 */
const stripAnchors = (html: string) => html.replace(/ data-rz-(?:section|kind|entry|field|raw)="[^"]*"/g, '');

/** 只留文本节点：打印面的文本层就是由这些字组成的，锚点多一个字这里就会露出来。 */
const textOnly = (html: string) => html.replace(/<[^>]*>/g, '');

/** HTML 属性值反实体（`escapeHtml` 的逆，只在这份用例里成对出现，不进生产码）。 */
const decodeAttr = (value: string) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

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

describe('3.10-02 打印面的区块/条目锚点是惰性属性（整屏编辑靠它命中）', () => {
  /** 产物指纹：md5 只用来比"两套模板不是同一张纸"，不是安全用途。 */
  const digest = (html: string) => createHash('md5').update(html, 'utf8').digest('hex');

  for (const id of ['classic', 'modern', 'minimal']) {
    it(`${id}：锚点计数 = 区块数与条目数，值逐个对得上，且锚点不带样式`, () => {
      const d = doc();
      const html = resumeTemplate.render(d, id);
      const entryCount = d.sections.reduce((sum, section) => sum + section.entries.length, 0);
      expect((html.match(/ data-rz-section="/g) ?? []).length).toBe(d.sections.length);
      expect((html.match(/ data-rz-kind="/g) ?? []).length).toBe(d.sections.length);
      expect((html.match(/ data-rz-entry="/g) ?? []).length).toBe(entryCount);
      for (const section of d.sections) {
        expect(html).toContain(`data-rz-section="${section.id}" data-rz-kind="${section.kind}"`);
        for (const entry of section.entries) expect(html).toContain(`data-rz-entry="${entry.id}"`);
      }
      expect(html).not.toContain('<style');
      expect(html).not.toContain('style="');
    });
  }

  it('加锚点前后：一字文本都不多（printToPDF 的文本层因此逐字不变）', () => {
    for (const id of ['classic', 'modern', 'minimal']) {
      const html = resumeTemplate.render(doc(), id);
      const stripped = stripAnchors(html);
      expect(stripped, `${id} 的锚点没挂上，判据空转`).not.toBe(html);
      expect(textOnly(stripped)).toBe(textOnly(html));
    }
  });

  it('两套模板各渲一次：产物 md5 互异（锚点没有把版式差别抹平）', () => {
    expect(digest(resumeTemplate.render(doc(), 'modern'))).not.toBe(digest(resumeTemplate.render(doc(), 'classic')));
  });
});

describe('3.11-04 纸上每一格都带得回写入坐标与原文（打字锚点是惰性的）', () => {
  /** 一格锚点对的两种形状：属性成对出现，值取自文档里的那一格。 */
  const PAIR = / data-rz-field="([^"]*)" data-rz-raw="([^"]*)"/g;

  it('标题、时间、正文三种格都有锚点，且 `data-rz-raw` 反解回来就是文档里那一格的原文', () => {
    const d = doc();
    const html = resumeTemplate.render(d, 'classic');
    const values = new Map(
      d.sections.flatMap((section) => section.entries.flatMap((entry) => entry.fields.map((f) => [f.key, f.value]))),
    );
    // 经历条 = 公司 + 职位 + 时间 + 成果，教育条 = 学校 + 专业（简介/技能那一族在另一个用例里）。
    const pairs = [...html.matchAll(PAIR)];
    expect(pairs.map((match) => decodeAttr(match[1] as string))).toEqual([
      'company',
      'role',
      'period',
      'achievement',
      'school',
      'major',
    ]);
    for (const match of pairs) {
      const key = decodeAttr(match[1] as string);
      // `data-rz-raw` 存的是 `JSON.stringify(原文)`：换行与引号因此能原样回来，多行正文不会被敲扁。
      expect(JSON.parse(decodeAttr(match[2] as string))).toBe(values.get(key));
    }
  });

  it('多行带标记的正文：纸面上已经是 `<li>`，锚点里仍是带 `- ` 与 `**` 的原文（这就是 `data-rz-raw` 存在的理由）', () => {
    const d = doc();
    const exp = d.sections.find((section) => section.kind === 'experience')!;
    exp.entries[0]!.fields.find((field) => field.key === 'achievement')!.value = '- **P99 下降 40%**\n- 主导迁移';
    const html = resumeTemplate.render(d, 'classic');
    expect(html).toContain('<ul class="list-disc');
    expect(html).toContain('<strong class="font-bold">');
    // 块级 HTML 里既没有 `- ` 也没有 `**`，所以只可能从这一枚属性里拿回来。
    expect(html).toContain(`data-rz-raw="${escapeHtml(JSON.stringify('- **P99 下降 40%**\n- 主导迁移'))}"`);
  });

  it('锚点成对挂上：`data-rz-field` 与 `data-rz-raw` 同数，且都是惰性属性（文本层一字不多）', () => {
    for (const id of ['classic', 'modern', 'minimal']) {
      const html = resumeTemplate.render(doc(), id);
      const fields = (html.match(/ data-rz-field="/g) ?? []).length;
      expect(fields, `${id} 的打字锚点没挂上，判据空转`).toBeGreaterThan(0);
      expect((html.match(/ data-rz-raw="/g) ?? []).length).toBe(fields);
      expect(textOnly(stripAnchors(html))).toBe(textOnly(html));
    }
  });

  it('剥掉锚点后的两套模板产物仍互异（锚点没把版式差别抹平）', () => {
    expect(stripAnchors(resumeTemplate.render(doc(), 'classic'))).not.toBe(
      stripAnchors(resumeTemplate.render(doc(), 'modern')),
    );
  });
});

describe('3.2-09 超长条目不截断（U 那一条：内容完整；页数增长属 V 交 3.3）', () => {
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
    // 数"有没有重复渲染"必须剥掉锚点再数：`data-rz-raw`（3.11-04）里本来就带着同一份原文，那是打字用的，不是第二遍渲染。
    expect(stripAnchors(html).match(/星桥科技/g)?.length).toBe(1); // 未重复
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
