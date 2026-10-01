/**
 * 模板系统 SPI 门面（spec 3.2-01 / 3.2-03）。
 *
 * 只做一件事：把 `./internal/templates.ts` 里的内置模板装进一张注册表，暴露 `list / get / render`
 * 三个方法（3.2-03），并留一个 `register` 运行期扩展位。核心代码不认识任何一套模板的排版细节——
 * 新增模板只往注册表加一条数据，`list/get/render` 一字不改。
 *
 * 绑定、转义、i18n 标签等基元在 `./internal/bind.ts`（三套模板共享，避免复制）。
 * 版面度量落地与打印分页在 3.3，不在模板里。
 */
import type { ResumeDocument } from './model.js';
import type { Template, TemplateContext, TemplateLocale } from './internal/bind.js';
import { BUILTIN_TEMPLATES } from './internal/templates.js';

export type { Template, TemplateContext, TemplateLocale, TemplateOrigin } from './internal/bind.js';
export { TemplateBindingError } from './internal/bind.js';

/** 运行期注册表；新增内置模板只改这张表的数据，不改下面的方法。 */
const registry = new Map<string, Template>();
for (const template of BUILTIN_TEMPLATES) registry.set(template.id, template);

/**
 * 列出全部可用模板（SPI 之一）。
 * @returns 模板数组（含 id / name / origin / render）
 */
export function list(): Template[] {
  return [...registry.values()];
}

/**
 * 按 id 取模板（SPI 之二）。
 * @param id 模板 id
 * @returns 命中的模板；不存在返回 null（调用方据此提示，不抛裸异常）
 */
export function get(id: string): Template | null {
  return registry.get(id) ?? null;
}

/**
 * 注册一套模板（运行期扩展位，佐证 3.2-03「新增不改核心」）。
 * @param template 合法 Template 对象
 * @throws 同 id 已存在时抛错，避免静默覆盖
 */
export function register(template: Template): void {
  if (registry.has(template.id)) {
    throw new Error(`模板 id 重复：${template.id}`);
  }
  registry.set(template.id, template);
}

/**
 * 用指定模板把文档渲染为 HTML（SPI 之三，预览 / 导出共用的唯一入口）。
 * @param doc 合法简历文档
 * @param templateId 模板 id
 * @param locale 语言，默认 `zh-CN`
 * @returns HTML 片段
 * @throws 未知 templateId 抛错；核心槽位缺数据抛 `TemplateBindingError`
 */
export function render(doc: ResumeDocument, templateId: string, locale: TemplateLocale = 'zh-CN'): string {
  const template = registry.get(templateId);
  if (!template) {
    throw new Error(`未知模板：${templateId}（可用：${[...registry.keys()].join(', ')}）`);
  }
  return template.render(doc, { locale } satisfies TemplateContext);
}

/** 把 SPI 收成一个对象，界面 / 服务侧按 `resumeTemplate.list()/get()/render()` 调用（3.2-03）。 */
export const resumeTemplate = { list, get, register, render };
