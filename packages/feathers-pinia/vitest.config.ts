import { defineConfig } from 'vitest/config'

// The upstream suite, kept as it was written: global test functions.
export default defineConfig({
  test: {
    globals: true,
    // The fork's own type tests (*.test-d.ts) run through tsc.
    typecheck: { enabled: true, include: ['tests/**/*.test-d.ts'], tsconfig: './tsconfig.test.json' }
  }
})
