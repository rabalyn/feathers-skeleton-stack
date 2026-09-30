// Lint (ADR 0014, 0015, 0018). Type-aware rules for every TypeScript package
// and the Vue components.
// The transitive client boundary of ADR 0007 is checked by dependency-cruiser
// (apps/api/.dependency-cruiser.cjs), which follows whole import chains.
import js from '@eslint/js'
import vueI18n from '@intlify/eslint-plugin-vue-i18n'
import pluginVue from 'eslint-plugin-vue'
import globals from 'globals'
import * as jsoncParser from 'jsonc-eslint-parser'
import tseslint from 'typescript-eslint'

const CODE = ['**/*.{js,cjs,mjs,ts,mts,cts,vue}']
const WEB = 'apps/web'
// Every key the code uses must exist in every catalogue (ADR 0014).
const i18nSettings = { 'vue-i18n': { localeDir: `${WEB}/src/i18n/*.json`, messageSyntaxVersion: '^11.0.0' } }

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/test-results/**',
      '**/playwright-report/**',
      // The service generator's scratch copy (apps/api/generators/check.sh).
      '**/.generator-check/**',
      '**/.quasar/**',
      '**/quasar.config.*.temporary.compiled*',
      // Vendored third-party code, kept close to upstream (ADR 0014).
      'packages/feathers-pinia/**'
    ]
  },
  { ...js.configs.recommended, files: CODE },
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({ ...config, files: CODE })),
  {
    files: CODE,
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
    // Transaction-mode pooling (ADR 0004): a session-level SET or advisory
    // lock stays on a server connection the next transaction may belong to
    // someone else. `migrate` connects directly and is the one exception.
    files: ['apps/api/**/*.{ts,js}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...['Literal', 'TemplateElement'].flatMap((node) => {
          const value = node === 'Literal' ? 'value' : 'value.raw'
          return [
            {
              selector: `${node}[${value}=/(^|;)\\s*SET\\s+(?!LOCAL\\b|TRANSACTION\\b|CONSTRAINTS\\b)/i]`,
              message: 'Session-level SET outlives the transaction under PgBouncer; use SET LOCAL inside a transaction (ADR 0004).'
            },
            {
              selector: `${node}[${value}=/pg_(try_)?advisory_(un)?lock/i]`,
              message: 'Session advisory locks break under transaction pooling; use pg_advisory_xact_lock (ADR 0004).'
            }
          ]
        })
      ]
    }
  },
  {
    files: ['**/*.js', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked
  },
  // The frontend (ADR 0014).
  ...pluginVue.configs['flat/recommended'].map((config) => ({ ...config, files: [`${WEB}/**/*.vue`] })),
  {
    files: [`${WEB}/**/*.vue`],
    languageOptions: {
      parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.vue'], projectService: true }
    },
    rules: {
      // Markup from data is an injection path (ADR 0018).
      'vue/no-v-html': 'error',
      // Formatting rules that fight one-line templates without catching
      // anything.
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off'
    }
  },
  {
    files: [`${WEB}/**/*.ts`, `${WEB}/**/*.vue`],
    languageOptions: { globals: globals.browser },
    plugins: { '@intlify/vue-i18n': vueI18n },
    settings: i18nSettings,
    rules: {
      // All user-facing text goes through the catalogues; digits and
      // punctuation alone are not text.
      '@intlify/vue-i18n/no-raw-text': ['error', { ignorePattern: '^[\\s\\d.,:;·()#/&+–-]+$' }],
      '@intlify/vue-i18n/no-missing-keys': 'error'
    }
  },
  {
    files: [`${WEB}/src/i18n/*.json`],
    languageOptions: { parser: jsoncParser },
    plugins: { '@intlify/vue-i18n': vueI18n },
    settings: i18nSettings,
    rules: {
      '@intlify/vue-i18n/no-missing-keys-in-other-locales': 'error',
      '@intlify/vue-i18n/no-duplicate-keys-in-locale': 'error',
      '@intlify/vue-i18n/no-html-messages': 'error'
    }
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
