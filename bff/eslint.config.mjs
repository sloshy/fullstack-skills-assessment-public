import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  // This file is plain JS outside every tsconfig, so the type-aware parser can't load it.
  { ignores: ['dist/', 'node_modules/', 'eslint.config.mjs'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        // tsconfig.json leaves tests out of the build; tsconfig.eslint.json adds them back so
        // the type-aware rules cover every file ESLint lints.
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // INC-4493: Express 4 ignored an async handler's rejected promise and Node exited.
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      // `const { merchantId: _merchantId, ...quote } = ...` is how this code drops a field,
      // so a rest sibling that is never read is intended, not dead code.
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },
);
