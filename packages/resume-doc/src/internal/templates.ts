/**
 * 内置模板清单（spec 3.2-01 / 3.2-02 / 3.2-03 / 3.2-05 / 3.2-06 / 3.2-07 / 3.2-10）。
 *
 * **抽取来源记录（3.2-10）**：50 套全部是 **clean-room 重写**——没有从任何外部站点或仓库取过一行
 * HTML/CSS/代码，只按「这类简历公版长什么样」的版面类型（抬头摆位 / 栏数 / 标题画法 / 强调色）
 * 用本包 `template-kit.ts` 的正交轴各取一种组合重新画出。每一套对应的现实参照与许可判定
 * 逐条记在 `docs/plans/03-resume-pdf/plan.md` §3.2「模板库选型与证据」那张表里（§8.7 的许可记账要求）。
 * 商用 SaaS（Novoresume/Zety/Canva/Resume.io 等）的模板文件受版权与专有许可保护，**一律不取**；
 * 开源侧（JSON Resume 主题、awesome-cv/LaTeX 模板等）只读其版面描述，不搬运代码。
 *
 * 每个 `render` 只把 `spec` 交给 `renderWithSpec`，因此本文件里没有任何排版逻辑——
 * 新增一套是往 PRESETS 追加一行数据（`template.ts` 的 list/get/render 一字不改，3.2-03）。
 * 模板里不出现字符串截断 / 日期或数字推断 / 事实新造（3.2-05），不写 `<style>` 或 `style="`（3.2-07）。
 */
import type { ResumeDocument } from '../model.js';
import type { Template, TemplateContext } from './bind.js';
import {
  renderWithSpec,
  type AccentHue,
  type HeaderVariant,
  type HeadingVariant,
  type TemplateSpec,
} from './template-kit.js';

/** 预设表的缺省值：一行数据只写它**偏离缺省**的那几条轴。 */
const DEFAULTS: TemplateSpec = {
  columns: 1,
  accent: 'neutral',
  header: 'left',
  heading: 'rule',
  entry: 'stack',
  density: 'normal',
  serif: false,
  nameSize: '3xl',
  nameWeight: 'bold',
  nameCaps: false,
  contactSep: ' · ',
  entryDivider: false,
  plainGrid: false,
};

/**
 * 造一套模板（把一行预设数据装成 `Template` 契约）。
 * @param id 模板 id（kebab-case，进产物文件名与快照行，一经发布不复用不改写）
 * @param name 界面展示名（中文，供模板选择器摆）
 * @param overrides 该套模板偏离缺省的版面取值
 * @returns 合法 Template 对象
 */
function preset(id: string, name: string, overrides: Partial<TemplateSpec>): Template {
  const spec: TemplateSpec = { ...DEFAULTS, ...overrides };
  return {
    id,
    name,
    origin: 'clean-room-rewrite',
    render(doc: ResumeDocument, ctx: TemplateContext): string {
      return renderWithSpec(doc, ctx, spec, id);
    },
  };
}

/** 一行预设的写法糖：把常改的几条轴排在一起，读表时能直接看出两行差在哪。 */
const row = (
  id: string,
  name: string,
  accent: AccentHue,
  header: HeaderVariant,
  heading: HeadingVariant,
  extra: Partial<TemplateSpec> = {},
): Template => preset(id, name, { accent, header, heading, ...extra });

/**
 * 50 套内置模板。
 *
 * 前三行（classic / modern / minimal）是 3.2 落地的原三套：id 与展示名**保持不变**，
 * 因为库里的快照行 `template_id` 已引用它们（spec 3.7-01），改名等于改写历史读数。
 * 其余 47 套按「求职者一眼能分辨」的版面类型铺开：单栏通投、双栏侧条、色块抬头、细线学术、
 * 大字创意、徽章技能、编号区块等，每套至少在两条轴上与相邻行不同。
 */
export const BUILTIN_TEMPLATES: Template[] = [
  // —— 3.2 原三套（id 冻结）——
  row('classic', '经典单栏', 'neutral', 'center', 'rule', { serif: true, nameSize: '2xl', entry: 'split' }),
  row('modern', '现代双列强调', 'sky', 'ruleUnder', 'leftBorder', { columns: 2, entry: 'split' }),
  row('minimal', '极简黑白', 'neutral', 'stacked', 'wide', {
    density: 'compact',
    nameSize: 'xl',
    nameWeight: 'semibold',
  }),
  // —— 47 套公版类型（clean-room 重写）——
  row('executive-amber', '高管琥珀', 'amber', 'ruleUnder', 'doubleRule', {
    serif: true,
    nameSize: '4xl',
    entry: 'split',
  }),
  row('legal-navy', '法务藏青', 'blue', 'center', 'rule', { serif: true, nameWeight: 'normal', contactSep: ' / ' }),
  row('designer-portfolio', '设计作品集', 'violet', 'split', 'pill', {
    nameSize: '[32px]',
    nameWeight: 'black',
    plainGrid: true,
  }),
  row('ats-plain', '通投极简', 'gray', 'left', 'wide', { density: 'compact', nameSize: 'xl', nameWeight: 'bold' }),
  row('graduate-campus', '校招应届', 'green', 'left', 'leftBorder', { nameSize: '2xl', entryDivider: true }),
  row('product-manager', '产品经理', 'indigo', 'split', 'block', { entry: 'split', nameCaps: false }),
  row('data-analyst', '数据分析师', 'teal', 'left', 'rule', { plainGrid: true, entry: 'split', density: 'compact' }),
  row('creative-studio', '创意工作室', 'rose', 'banner', 'pill', { nameWeight: 'black', nameSize: '[28px]' }),
  row('finance-formal', '财务严谨', 'stone', 'ruleUnder', 'numbered', { serif: true, entry: 'split' }),
  row('medical-clean', '医护洁净', 'emerald', 'center', 'rule', { nameSize: '2xl', contactSep: ' | ' }),
  row('teaching-grid', '教师简历', 'blue', 'left', 'bar', { plainGrid: true, nameSize: '2xl' }),
  row('marketing-bold', '市场醒目', 'amber', 'banner', 'block', {
    nameWeight: 'extrabold',
    nameCaps: true,
    entry: 'split',
  }),
  row('research-academic', '学术科研', 'neutral', 'center', 'numbered', {
    serif: true,
    density: 'roomy',
    nameSize: '2xl',
  }),
  row('design-sidebar', '侧栏设计', 'violet', 'stacked', 'leftBorder', { columns: 2, entry: 'split' }),
  row('startup-founder', '创业者', 'slate', 'banner', 'wide', { nameWeight: 'black', nameSize: '[32px]' }),
  row('consulting-formal', '咨询正式', 'gray', 'split', 'doubleRule', {
    serif: true,
    entry: 'split',
    density: 'roomy',
  }),
  row('global-modern', '海外通用', 'sky', 'split', 'rule', { nameCaps: true, contactSep: ' | ', entry: 'split' }),
  row('heritage-red', '中式传统', 'red', 'boxed', 'bar', { serif: true, nameSize: '[28px]' }),
  row('quiet-gray', '灰阶静默', 'zinc', 'stacked', 'underlineShort', { density: 'compact', nameWeight: 'medium' }),
  row('bold-typography', '大字排版', 'rose', 'left', 'block', { nameSize: '5xl', nameWeight: 'black' }),
  row('quiet-luxury', '静奢细字', 'stone', 'center', 'wide', { serif: true, nameWeight: 'normal', density: 'roomy' }),
  row('tech-indigo', '科技靛蓝', 'indigo', 'ruleUnder', 'bar', { entry: 'split', nameCaps: true }),
  row('fresh-emerald', '清新青绿', 'emerald', 'left', 'pill', { plainGrid: true, nameSize: '2xl' }),
  row('warm-amber', '暖橙亲和', 'amber', 'left', 'leftBorder', { density: 'roomy', nameSize: '2xl' }),
  row('precise-blue', '精准蓝', 'blue', 'left', 'numbered', { density: 'compact', entry: 'split', nameSize: 'xl' }),
  row('elegant-serif', '雅致衬线', 'neutral', 'center', 'underlineShort', { serif: true, nameSize: '4xl' }),
  row('compact-two-col', '紧凑双栏', 'slate', 'stacked', 'wide', { columns: 2, density: 'compact' }),
  row('sidebar-teal', '青绿侧栏', 'teal', 'banner', 'rule', { columns: 2, nameSize: '2xl' }),
  row('sidebar-violet', '紫调侧栏', 'violet', 'boxed', 'leftBorder', { columns: 2 }),
  row('skills-grid', '技能网格', 'sky', 'left', 'rule', { plainGrid: true, entry: 'split' }),
  row('timeline-clean', '时间线清爽', 'neutral', 'split', 'doubleRule', { entry: 'split', entryDivider: true }),
  row('ats-optimized', 'ATS 友好', 'gray', 'left', 'rule', { density: 'compact', nameSize: 'xl', entryDivider: false }),
  row('mentor-senior', '资深顾问', 'blue', 'boxed', 'block', { serif: true, nameSize: '2xl', entry: 'split' }),
  row('intern-first', '实习第一份', 'green', 'left', 'bar', { nameSize: 'xl', density: 'roomy' }),
  row('business-pm', '商务项目', 'indigo', 'ruleUnder', 'numbered', { entry: 'split', nameWeight: 'extrabold' }),
  row('recruiter-scan', '招聘官速览', 'rose', 'split', 'bar', { density: 'compact', entry: 'split', plainGrid: true }),
  row('design-system', '设计系统', 'violet', 'left', 'underlineShort', { nameCaps: true, plainGrid: true }),
  row('operations-split', '运营效率', 'amber', 'split', 'rule', { entry: 'split', contactSep: ' | ' }),
  row('contract-serif', '合同严谨', 'stone', 'center', 'doubleRule', { serif: true, entry: 'split', density: 'roomy' }),
  row('media-voice', '传媒之声', 'rose', 'ruleUnder', 'wide', { nameWeight: 'extrabold', nameSize: '[28px]' }),
  row('hospitality-warm', '服务亲和', 'teal', 'center', 'pill', { nameSize: '2xl', contactSep: ' / ' }),
  row('industry-plant', '工业规范', 'zinc', 'left', 'numbered', {
    entry: 'split',
    density: 'compact',
    entryDivider: true,
  }),
  row('sales-target', '销售战报', 'red', 'banner', 'block', { nameCaps: true, nameWeight: 'black', entry: 'split' }),
  row('architect-drawing', '建筑制图', 'slate', 'stacked', 'doubleRule', {
    nameSize: 'xl',
    density: 'roomy',
    entry: 'split',
  }),
  row('gamedev-dark', '游戏开发', 'violet', 'banner', 'pill', { nameCaps: true, nameSize: '[32px]' }),
  row('wellness-balance', '健康平衡', 'emerald', 'split', 'underlineShort', { nameSize: '2xl', plainGrid: true }),
  row('logistics-express', '物流快线', 'zinc', 'split', 'leftBorder', { entry: 'split', density: 'compact' }),
];
