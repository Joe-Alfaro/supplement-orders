import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import pluginVue from 'eslint-plugin-vue'
import testingLibrary from 'eslint-plugin-testing-library'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'notes/**',
      '.claude/**',
      'test-results/**',
      'playwright-report/**',
      'blob-report/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
    },
  },
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-var': 'error',
      'prefer-const': 'error',
      'no-nested-ternary': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ForStatement',
          message:
            'Use array methods (.map, .forEach, .reduce) instead of for loops.',
        },
        {
          selector: 'ForInStatement',
          message:
            'Use Object.keys/entries with array methods instead of for...in.',
        },
        {
          selector: 'ForOfStatement',
          message:
            'Use array methods (.map, .forEach, .reduce) instead of for...of.',
        },
      ],
    },
  },
  {
    // Testing Library conventions (FRONTEND_DESIGN.md §10).
    files: ['**/*.test.ts'],
    ...testingLibrary.configs['flat/vue'],
    rules: {
      ...testingLibrary.configs['flat/vue'].rules,
      'testing-library/prefer-user-event': 'error',
      'testing-library/no-container': 'error',
      'testing-library/no-node-access': 'error',
      'testing-library/prefer-screen-queries': 'error',
    },
  },
  prettier,
)
