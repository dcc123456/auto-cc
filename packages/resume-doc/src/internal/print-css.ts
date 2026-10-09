/**
 * 打印层工具类样式表（spec 3.2-07 的执行半边）。
 *
 * **为什么存在**：模板按 3.2-07 只用 Tailwind utility class 表达版面，而打印 HTML 是一份**自足文档**
 * （`buildPrintHtml` 产出的 `<!doctype html>` 要交给离屏视图 `printToPDF`），它不经过渲染层那条 vite+tailwind
 * 编译链，因此页面上写 `text-2xl` 在过去只是一串没有规则与之对应的名字——于是三套模板导出的 PDF 像素相同
 * （spec 3.2-02 那条「成色比名字听起来薄」的告警真正的原因）。本文件把模板用到的 utility 语义按 Tailwind
 * 官方取值补齐，让 class 在打印文档里真的算数。
 *
 * 分层口径：这不是渲染层的第二套样式系统（§5.1 的 Tailwind only 管的是 `packages/renderer`），
 * 它是**产物文档**自带的样式表；app 界面与简历 PDF 是两份文档，各自需要一份能独立解析的 CSS。
 * 取名与取值一律照 Tailwind v4 官方 utility，不在这份表之外新增自造 class。
 */

/** 色相档位（照 Tailwind 官方调色板取常用几档，够用即止，不为凑全而堆）。 */
const PALETTE: Record<string, Record<number, string>> = {
  neutral: {
    100: '#f5f5f5',
    200: '#e5e5e5',
    300: '#d4d4d4',
    400: '#a3a3a3',
    500: '#737373',
    600: '#525252',
    700: '#404040',
    800: '#262626',
    900: '#171717',
    950: '#0a0a0a',
  },
  stone: {
    100: '#f5f5f4',
    200: '#e7e5e4',
    300: '#d6d3d1',
    400: '#a8a29e',
    500: '#78716c',
    600: '#57534e',
    700: '#44403c',
    800: '#292524',
    900: '#1c1917',
  },
  slate: {
    100: '#f1f5f9',
    200: '#e2e8f0',
    300: '#cbd5e1',
    400: '#94a3b8',
    500: '#64748b',
    600: '#475569',
    700: '#334155',
    800: '#1e293b',
    900: '#0f172a',
  },
  zinc: {
    100: '#f4f4f5',
    200: '#e4e4e7',
    300: '#d4d4d8',
    400: '#a1a1aa',
    500: '#71717a',
    600: '#52525b',
    700: '#3f3f46',
    800: '#27272a',
    900: '#18181b',
  },
  sky: {
    100: '#e0f2fe',
    200: '#bae6fd',
    300: '#7dd3fc',
    400: '#38bdf8',
    500: '#0ea5e9',
    600: '#0284c7',
    700: '#0369a1',
    800: '#075985',
    900: '#0c4a6e',
  },
  teal: {
    100: '#ccfbf1',
    200: '#99f6e4',
    300: '#5eead4',
    400: '#2dd4bf',
    500: '#14b8a6',
    600: '#0d9488',
    700: '#0f766e',
    800: '#115e59',
    900: '#134e4a',
  },
  emerald: {
    100: '#d1fae5',
    200: '#a7f3d0',
    300: '#6ee7b7',
    400: '#34d399',
    500: '#10b981',
    600: '#059669',
    700: '#047857',
    800: '#065f46',
    900: '#064e3b',
  },
  amber: {
    100: '#fef3c7',
    200: '#fde68a',
    300: '#fcd34d',
    400: '#fbbf24',
    500: '#f59e0b',
    600: '#d97706',
    700: '#b45309',
    800: '#92400e',
    900: '#78350f',
  },
  rose: {
    100: '#ffe4e6',
    200: '#fecdd3',
    300: '#fda4af',
    400: '#fb7185',
    500: '#f43f5e',
    600: '#e11d48',
    700: '#be123c',
    800: '#9f1239',
    900: '#881337',
  },
  violet: {
    100: '#ede9fe',
    200: '#ddd6fe',
    300: '#c4b5fd',
    400: '#a78bfa',
    500: '#8b5cf6',
    600: '#7c3aed',
    700: '#6d28d9',
    800: '#5b21b6',
    900: '#4c1d95',
  },
  indigo: {
    100: '#e0e7ff',
    200: '#c7d2fe',
    300: '#a5b4fc',
    400: '#818cf8',
    500: '#6366f1',
    600: '#4f46e5',
    700: '#4338ca',
    800: '#3730a3',
    900: '#312e81',
  },
  red: {
    100: '#fee2e2',
    200: '#fecaca',
    300: '#fca5a5',
    400: '#f87171',
    500: '#ef4444',
    600: '#dc2626',
    700: '#b91c1c',
    800: '#991b1b',
    900: '#7f1d1d',
  },
  blue: {
    100: '#dbeafe',
    200: '#bfdbfe',
    300: '#93c5fd',
    400: '#60a5fa',
    500: '#3b82f6',
    600: '#2563eb',
    700: '#1d4ed8',
    800: '#1e40af',
    900: '#1e3a8a',
  },
  green: {
    100: '#dcfce7',
    200: '#bbf7d0',
    300: '#86efac',
    400: '#4ade80',
    500: '#22c55e',
    600: '#16a34a',
    700: '#15803d',
    800: '#166534',
    900: '#14532d',
  },
  gray: {
    100: '#f3f4f6',
    200: '#e5e7eb',
    300: '#d1d5db',
    400: '#9ca3af',
    500: '#6b7280',
    600: '#4b5563',
    700: '#374151',
    800: '#1f2937',
    900: '#111827',
  },
};

/** Tailwind 间距档（rem）——外边距、内边距、`gap` 三族共用这一张表。 */
const SPACING: Record<string, string> = {
  px: '1px',
  '0': '0px',
  '0.5': '2px',
  '1': '4px',
  '1.5': '6px',
  '2': '8px',
  '2.5': '10px',
  '3': '12px',
  '3.5': '14px',
  '4': '16px',
  '5': '20px',
  '6': '24px',
  '7': '28px',
  '8': '32px',
  '9': '36px',
  '10': '40px',
  '12': '48px',
  '14': '56px',
  '16': '64px',
  '20': '80px',
};

/** Tailwind 字号档（`font-size` + `line-height` 成对，与官方 utility 一致）。 */
const TEXT_SIZES: Record<string, [string, string]> = {
  xs: ['0.75rem', '1rem'],
  sm: ['0.875rem', '1.25rem'],
  base: ['1rem', '1.5rem'],
  lg: ['1.125rem', '1.75rem'],
  xl: ['1.25rem', '1.75rem'],
  '2xl': ['1.5rem', '2rem'],
  '3xl': ['1.875rem', '2.25rem'],
  '4xl': ['2.25rem', '2.5rem'],
  '5xl': ['3rem', '1'],
};

/** 字重档（Tailwind `font-*`）。 */
const FONT_WEIGHTS: Record<string, string> = {
  thin: '100',
  light: '300',
  normal: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
  extrabold: '800',
  black: '900',
};

/** 自定义字号（任意值档，模板里以 `text-[9px]` 这类写法出现）。 */
const PIXEL_SIZES = [
  '8px',
  '9px',
  '10px',
  '11px',
  '12px',
  '13px',
  '14px',
  '16px',
  '18px',
  '20px',
  '24px',
  '28px',
  '32px',
];

/** `tracking-*` 字距档（Tailwind 官方 em 值）。 */
const TRACKING: Record<string, string> = {
  tighter: '-0.05em',
  tight: '-0.025em',
  normal: '0',
  wide: '0.025em',
  wider: '0.05em',
  widest: '0.1em',
};

/** `leading-*` 行距档。 */
const LEADING: Record<string, string> = {
  none: '1',
  tight: '1.25',
  snug: '1.375',
  normal: '1.5',
  relaxed: '1.625',
  loose: '2',
};

/** `rounded-*` 圆角档。 */
const RADIUS: Record<string, string> = {
  none: '0px',
  sm: '0.125rem',
  DEFAULT: '0.25rem',
  md: '0.375rem',
  lg: '0.5rem',
  xl: '0.75rem',
  '2xl': '1rem',
  '3xl': '1.5rem',
  full: '9999px',
};

/** `border-*` 线宽档。 */
const BORDER_WIDTH: Record<string, string> = {
  '0': '0px',
  DEFAULT: '1px',
  '2': '2px',
  '4': '4px',
  '8': '8px',
};

/**
 * 把 class 名转成合法 CSS 选择器（`[11px]` `2xl` `.` 这类字面量必须转义，否则整条规则作废）。
 * @param token utility class 名（不含前导点）
 * @returns 可直接写进样式表的选择器体
 */
function escapeSelector(token: string): string {
  return token.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch} `);
}

/** utility → 声明串。生成一次、模板与机检共用同一份真相（§2.2）。 */
const rules = new Map<string, string>();

const put = (token: string, declarations: string): void => {
  const existing = rules.get(token);
  rules.set(token, existing === undefined ? declarations : `${existing};${declarations}`);
};

// —— 间距：m*/p*（含四边与 auto）——
for (const [step, value] of Object.entries(SPACING)) {
  put(`m-${step}`, `margin:${value}`);
  put(`mx-${step}`, `margin-left:${value};margin-right:${value}`);
  put(`my-${step}`, `margin-top:${value};margin-bottom:${value}`);
  put(`mt-${step}`, `margin-top:${value}`);
  put(`mb-${step}`, `margin-bottom:${value}`);
  put(`ml-${step}`, `margin-left:${value}`);
  put(`mr-${step}`, `margin-right:${value}`);
  put(`p-${step}`, `padding:${value}`);
  put(`px-${step}`, `padding-left:${value};padding-right:${value}`);
  put(`py-${step}`, `padding-top:${value};padding-bottom:${value}`);
  put(`pt-${step}`, `padding-top:${value}`);
  put(`pb-${step}`, `padding-bottom:${value}`);
  put(`pl-${step}`, `padding-left:${value}`);
  put(`pr-${step}`, `padding-right:${value}`);
  put(`gap-${step}`, `gap:${value}`);
  put(`w-${step}`, `width:${value}`);
  put(`h-${step}`, `height:${value}`);
  put(`gap-x-${step}`, `column-gap:${value}`);
  put(`gap-y-${step}`, `row-gap:${value}`);
}
put('m-auto', 'margin:auto');
put('mx-auto', 'margin-left:auto;margin-right:auto');

// —— 字号 / 字重 / 行距 / 字距 ——
for (const [step, [fontSize, lineHeight]] of Object.entries(TEXT_SIZES)) {
  put(`text-${step}`, `font-size:${fontSize};line-height:${lineHeight}`);
}
for (const px of PIXEL_SIZES) {
  put(`text-[${px}]`, `font-size:${px}`);
}
for (const [name, value] of Object.entries(FONT_WEIGHTS)) {
  put(`font-${name}`, `font-weight:${value}`);
}
for (const [name, value] of Object.entries(LEADING)) {
  put(`leading-${name}`, `line-height:${value}`);
}
for (const [name, value] of Object.entries(TRACKING)) {
  put(`tracking-${name}`, `letter-spacing:${value}`);
}

// —— 族名：衬线 / 无衬线 / 等宽（都是系统族栈，不下载网络字体）——
put('font-sans', "font-family:'Noto Sans SC',system-ui,-apple-system,'Segoe UI',sans-serif");
put('font-serif', "font-family:Georgia,'Times New Roman','Noto Serif SC',serif");
put('font-mono', "font-family:ui-monospace,'SFMono-Regular',Menlo,Consolas,monospace");

// —— 颜色：text-* / bg-* / border-*（色值与 Tailwind 官方一致）——
for (const [hue, steps] of Object.entries(PALETTE)) {
  for (const [step, hex] of Object.entries(steps)) {
    put(`text-${hue}-${step}`, `color:${hex}`);
    put(`bg-${hue}-${step}`, `background-color:${hex}`);
    put(`border-${hue}-${step}`, `border-color:${hex}`);
  }
}
put('text-white', 'color:#ffffff');
put('bg-white', 'background-color:#ffffff');
put('bg-transparent', 'background-color:transparent');
put('text-black', 'color:#000000');
put('bg-black', 'background-color:#000000');

// —— 边框：四边与线宽（`border` 不带档名那一支单独给，避免长出 `border-DEFAULT` 这种没人用的规则）——
for (const [step, value] of Object.entries(BORDER_WIDTH)) {
  if (step === 'DEFAULT') continue;
  // 产物文档没有 Tailwind preflight，线宽必须自带 `border-style:solid`，否则只写宽度画不出线。
  put(`border-${step}`, `border-width:${value};border-style:solid`);
  put(`border-t-${step}`, `border-top-width:${value};border-top-style:solid`);
  put(`border-b-${step}`, `border-bottom-width:${value};border-bottom-style:solid`);
  put(`border-l-${step}`, `border-left-width:${value};border-left-style:solid`);
  put(`border-r-${step}`, `border-right-width:${value};border-right-style:solid`);
}
put('border', 'border-width:1px;border-style:solid');
put('border-t', 'border-top-width:1px;border-top-style:solid');
put('border-b', 'border-bottom-width:1px;border-bottom-style:solid');
put('border-l', 'border-left-width:1px;border-left-style:solid');
put('border-r', 'border-right-width:1px;border-right-style:solid');

// —— 圆角 ——
for (const [name, value] of Object.entries(RADIUS)) {
  put(name === 'DEFAULT' ? 'rounded' : `rounded-${name}`, `border-radius:${value}`);
}

// —— 弹性/网格布局 ——
put('flex', 'display:flex');
put('inline-flex', 'display:inline-flex');
put('grid', 'display:grid');
put('block', 'display:block');
put('inline-block', 'display:inline-block');
put('hidden', 'display:none');
put('flex-col', 'flex-direction:column');
put('flex-row', 'flex-direction:row');
put('flex-wrap', 'flex-wrap:wrap');
put('flex-1', 'flex:1 1 0%');
put('shrink-0', 'flex-shrink:0');
put('grow', 'flex-grow:1');
put('items-start', 'align-items:flex-start');
put('items-center', 'align-items:center');
put('items-end', 'align-items:flex-end');
put('items-baseline', 'align-items:baseline');
put('justify-start', 'justify-content:flex-start');
put('justify-center', 'justify-content:center');
put('justify-end', 'justify-content:flex-end');
put('justify-between', 'justify-content:space-between');
put('grid-cols-1', 'grid-template-columns:repeat(1,minmax(0,1fr))');
put('grid-cols-2', 'grid-template-columns:repeat(2,minmax(0,1fr))');
put('grid-cols-3', 'grid-template-columns:repeat(3,minmax(0,1fr))');
put('col-span-2', 'grid-column:span 2 / span 2');
put('col-span-3', 'grid-column:span 3 / span 3');
put('w-full', 'width:100%');
put('w-auto', 'width:auto');
put('min-w-0', 'min-width:0');
put('text-left', 'text-align:left');
put('text-center', 'text-align:center');
put('text-right', 'text-align:right');
put('text-justify', 'text-align:justify');
put('align-top', 'vertical-align:top');
put('align-middle', 'vertical-align:middle');

// —— 文本装饰与变换 ——
put('uppercase', 'text-transform:uppercase');
put('lowercase', 'text-transform:lowercase');
put('capitalize', 'text-transform:capitalize');
put('normal-case', 'text-transform:none');
put('italic', 'font-style:italic');
put('not-italic', 'font-style:normal');
put('underline', 'text-decoration-line:underline');
put('no-underline', 'text-decoration-line:none');
put('line-through', 'text-decoration-line:line-through');
put('truncate', 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap');
put('whitespace-nowrap', 'white-space:nowrap');
put('break-words', 'overflow-wrap:break-word');
put('list-none', 'list-style-type:none');
put('list-disc', 'list-style-type:disc');

// —— 打印分页护栏（与 baseRule 里的 `.resume-entry` 同源，class 版供模板按 3.2-07 表达）——
put('break-inside-avoid', 'break-inside:avoid');
put('break-after-avoid', 'break-after:avoid');
put('break-before-avoid', 'break-before:avoid');

/**
 * 模板可用的 utility class 集合（`template.test.ts` 用它做覆盖机检：
 * 模板渲染产物里出现的每一个 class 都必须在这里有对应规则，否则等于写了一串不会生效的样式）。
 */
export const PRINT_UTILITY_KEYS: ReadonlySet<string> = new Set(rules.keys());

/** 完整打印样式表（`buildPrintHtml` 内联进产物文档，预览与导出同一份）。 */
export const PRINT_STYLESHEET: string = [...rules.entries()]
  .map(([token, declarations]) => `.${escapeSelector(token)}{${declarations};}`)
  .join('');
