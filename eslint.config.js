// @ts-check
import tseslint from 'typescript-eslint';

// Use the flat config array directly to avoid the deprecated tseslint.config() wrapper.
export default [
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
];
