import tseslint from 'typescript-eslint';

const INTERNAL = {
  group: ['**/src/internal/**'],
  message: 'cross-package deep import into src/internal is forbidden; go through the package entry / a cordis service',
};
const CORDIS = {
  group: ['cordis', 'cordis/*', '@cordisjs/*', '@cordisjs/*/*'],
  message: "do not import 'cordis' directly — re-export it from @auto-cc/core so upgrades touch one place",
};

const CJK = '[\\u4e00-\\u9fff]';

/** 渲染层硬约束：样式只用 Tailwind、图标只用 lucide、文案只走 i18n、不碰 Node。 */
const RENDERER_SYNTAX = [
  {
    selector: "JSXAttribute[name.name='style']",
    message: '布局必须用 Tailwind 类，不允许内联 style（AGENTS.md §5.1）',
  },
  {
    selector: "ImportDeclaration[source.value=/\\.css$/]:not([source.value='./globals.css'])",
    message: '渲染层只允许入口 globals.css，禁止 CSS Module / CSS-in-JS（AGENTS.md §5.1）',
  },
  {
    selector: 'ImportDeclaration[source.value=/emotion|styled-components|goober|linaria/]',
    message: '禁止 CSS-in-JS 依赖，样式只走 Tailwind（AGENTS.md §5.1）',
  },
  {
    selector: "JSXIdentifier[name='svg']",
    message: '图标只能来自 lucide-react，不允许自绘 SVG（AGENTS.md §5.3）',
  },
  {
    selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
    message: '图标只能来自 lucide-react，不允许注入原始 HTML/SVG（AGENTS.md §5.3）',
  },
  { selector: `Literal[value=/${CJK}/]`, message: '页面文案必须走 i18n（AGENTS.md §5.5）' },
  { selector: `JSXText[value=/${CJK}/]`, message: '页面文案必须走 i18n（AGENTS.md §5.5）' },
  { selector: `TemplateElement[value.raw=/${CJK}/]`, message: '页面文案必须走 i18n（AGENTS.md §5.5）' },
  {
    selector: 'ImportDeclaration[source.value=/^(node:|fs|path|os|child_process|net|http|sqlite)/]',
    message: '渲染层运行在 sandbox 里，不允许引用 Node 内置模块（spec 1.2-04）',
  },
  {
    selector: "CallExpression[callee.name='require']",
    message: '渲染层不允许 require，主进程能力只经 window.autoCC 白名单（spec 1.2-04）',
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/out/**',
      // staging 与安装包产物是构建输出，不是源码；esbuild 的注释排版交给构建器而不是 lint。
      'build/**',
      'docs/acceptance/**',
      'tmp/**',
      'packages/renderer/**/generated/**',
    ],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      'no-restricted-imports': ['error', { patterns: [INTERNAL, CORDIS] }],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-member-accessibility': 'off',
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    // the single place allowed to touch cordis
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [INTERNAL] }],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.spec.ts', 'packages/testing/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
  {
    // 应用代码本身（不含 vite.config.ts 等构建脚本，它们跑在 Node 里）
    files: ['packages/renderer/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error', ...RENDERER_SYNTAX],
      'no-restricted-imports': [
        'error',
        {
          patterns: [INTERNAL, CORDIS],
          paths: [{ name: 'react-dom/server', message: '渲染层不做服务端渲染，只挂载到 #root' }],
        },
      ],
    },
  },
);
