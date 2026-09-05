import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/', 'coverage/', '**/node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // v3 message handlers intentionally take `any` until runtime schema
      // validation lands in Phase 1; revisit then.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Admin web UI: DOM/node globals come from tsc lib types; no-undef would
    // false-positive on them (typescript-eslint guidance).
    files: ['packages/admin-ui/**/*.{ts,tsx}'],
    rules: { 'no-undef': 'off' },
  },
);
