import { builtinModules } from 'node:module';

import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const restrictedBuiltinImports = builtinModules
  .filter((name) => !name.startsWith('_') && !name.startsWith('node:'))
  .map((name) => ({
    name,
    message: `Use node:${name} instead of bare builtin imports.`,
  }));

export default defineConfig([
  globalIgnores([
    '**/node_modules/**',
    '**/dist/**',
    '**/coverage/**',
    '**/tmp/**',
    '**/temp/**',
    '**/cache/**',
    '**/.cache/**',
  ]),
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,ts,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        URL: 'readonly',
      },
    },
    rules: {
      'no-console': 'warn',
      'no-debugger': 'error',
      'no-duplicate-imports': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: restrictedBuiltinImports,
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.type='Identifier'][callee.name='require']",
          message: 'Use ESM imports instead of require() in module files.',
        },
        {
          selector:
            "AssignmentExpression[left.type='MemberExpression'][left.object.type='Identifier'][left.object.name='module'][left.property.type='Identifier'][left.property.name='exports']",
          message: 'Use ESM exports instead of module.exports in module files.',
        },
        {
          selector:
            "AssignmentExpression[left.type='MemberExpression'][left.object.type='Identifier'][left.object.name='exports']",
          message: 'Use ESM named exports instead of exports.* assignments in module files.',
        },
      ],
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      'no-console': 'warn',
      'no-debugger': 'error',
    },
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['**/*.{ts,tsx}'],
  })),
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['test/**/*.{js,mjs,cjs,ts,tsx}', '**/*.{spec,test}.{js,mjs,cjs,ts,tsx}'],
    languageOptions: {
      globals: globals.mocha,
    },
  },
  prettierConfig,
]);
