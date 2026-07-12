import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'node_modules/', 'examples/'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Interface-driven code legitimately narrows unknown driver/config values.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // We interpolate validated numbers/known enums into SQL and messages.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: true }],
      // Fire-and-forget with explicit `void` is an accepted pattern here.
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      // Async signatures are dictated by the extension-point interfaces
      // (SecretProvider, DialectDriver, McpTool, ...) even when an
      // implementation happens to be synchronous.
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    files: ['test/**'],
    rules: {
      // Tests assert on loosely-typed protocol payloads.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['*.config.ts', 'eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
