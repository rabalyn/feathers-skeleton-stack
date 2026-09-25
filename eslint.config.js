// Lint (ADR 0015, 0018). Type-aware rules for every TypeScript package.
// The transitive client boundary of ADR 0007 is checked by dependency-cruiser
// (apps/api/.dependency-cruiser.cjs), which follows whole import chains.
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/test-results/**',
      '**/playwright-report/**',
      // Vendored third-party code, kept close to upstream (ADR 0014).
      'packages/feathers-pinia/**'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
    },
    rules: {
      // A floating promise is a swallowed error or an unordered side effect.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Feathers hooks and resolvers are async by contract, awaiting or not.
      '@typescript-eslint/require-await': 'off',
      eqeqeq: ['error', 'always'],
      'no-console': 'error'
    }
  },
  {
    files: ['**/*.js', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked
  },
  {
    // Tests assert on loosely typed rows and error objects.
    files: ['apps/api/test/**', 'e2e/**'],
    rules: {
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      'no-console': 'off'
    }
  }
)
