import tseslint from 'typescript-eslint';

const INTERNAL = {
  group: ['**/src/internal/**'],
  message: 'cross-package deep import into src/internal is forbidden; go through the package entry / a cordis service',
};
const CORDIS = {
  group: ['cordis', 'cordis/*', '@cordisjs/*', '@cordisjs/*/*'],
  message: "do not import 'cordis' directly — re-export it from @auto-cc/core so upgrades touch one place",
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/out/**',
      'docs/acceptance/**',
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
);
