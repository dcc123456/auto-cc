import tseslint from 'typescript-eslint';

const INTERNAL = {
  group: ['**/src/internal/**'],
  message: 'cross-package deep import into src/internal is forbidden; go through the package entry / a cordis service',
};
const CORDIS = {
  group: ['cordis', 'cordis/*', '@cordisjs/*', '@cordisjs/*/*'],
  message: "do not import 'cordis' directly — re-export it from @auto-cc/core so upgrades touch one place",
};

/**
 * agent 层的能力包边界（spec 5.1-08）。
 *
 * 对话里的 agent 只能经 `agent.tools` 注册表向能力包要动作，不许 `import` 任何一只「手」：
 * 一旦 import 进来，它就能绕开注册表直接调 service——那条路上没有入参校验、没有额度闸门、
 * 没有审批档位、也不在工具卡片上留痕（AGENTS.md §5.9 禁止的正是"各长一套业务逻辑"）。
 * 名单按 5.1-08 点到的四族展开（包名的真形是 `@auto-cc/plugin-*`，写成 `@auto-cc/browser` 会让这条规则空转）：
 * `browser.*`→ plugin-browser + plugin-sessions（内核会话是浏览器能力的持有者）、
 * `platform.*` / `jd.*`→ plugin-platform-boss + plugin-outbound（JD 抓取与打招呼/投递的动作都在这两家）、
 * `resume.*` / `kb.*`→ plugin-resume-doc + plugin-resume-kb。
 * **故意不列** `@auto-cc/plugin-workflow`：plan 与 §5.9 要求对话与工作流共用同一个 `workflow.runner`，
 * 把它禁掉会逼出第二套编排；`plugin-llm` / `plugin-entitlement` 同理不在禁令里，
 * agent 的对话腿要发模型、档位判定要问闸门。
 */
const AGENT_CAPABILITY = {
  group: [
    '@auto-cc/plugin-browser',
    '@auto-cc/plugin-browser/**',
    '@auto-cc/plugin-sessions',
    '@auto-cc/plugin-sessions/**',
    '@auto-cc/plugin-platform-*',
    '@auto-cc/plugin-platform-*/**',
    '@auto-cc/plugin-outbound',
    '@auto-cc/plugin-outbound/**',
    '@auto-cc/plugin-resume-doc',
    '@auto-cc/plugin-resume-doc/**',
    '@auto-cc/plugin-resume-kb',
    '@auto-cc/plugin-resume-kb/**',
  ],
  message:
    'agent 层不得直接 import 能力包：动作只能经 agent.tools 注册表调用，否则绕过入参校验、闸门与工具卡片（spec 5.1-08 / AGENTS.md §5.9）',
};

const CJK = '[\\u4e00-\\u9fff]';

/** 渲染层硬约束：样式只用 Tailwind、图标只用 lucide、文案只走 i18n、不碰 Node。 */
const RENDERER_SYNTAX = [
  {
    selector: "JSXAttribute[name.name='style']",
    message: '布局必须用 Tailwind 类，不允许内联 style（AGENTS.md §5.1）',
  },
  {
    // 第三方库样式的**唯一**例外：@xyflow/react 的画布视口与连线全靠这份 CSS，不引就画不出来
    // （AGENTS.md §5.2 的例外条款，记账见 docs/specs/05-chat-agent 的 5.10-16 落地记录）。
    // 放行写成精确字面量而不是放宽正则——否则任何人 import 一个 .css 都能过。
    selector:
      "ImportDeclaration[source.value=/\\.css$/]:not([source.value='./globals.css']):not([source.value='@xyflow/react/dist/style.css'])",
    message: '渲染层只允许入口 globals.css 与 @xyflow/react 的库样式，禁止 CSS Module / CSS-in-JS（AGENTS.md §5.1）',
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
      // §6.4 的一次性 spike 副本（结论进文档、代码不进主干），不参与主干 lint。
      '.research-repos/**',
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
  {
    // spec 5.1-08 的依赖边界。只管 `src/`：测试替身按名字假装配一只能力包不算架构越界，
    // 而运行期代码里出现这些 import，就等于 agent 有了绕过注册表的第二条路。
    files: ['packages/agent/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [INTERNAL, CORDIS, AGENT_CAPABILITY] }],
    },
  },
);
