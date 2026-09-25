import { defineConfig } from 'vitest/config'

// The upstream suite, kept as it was written: global test functions.
export default defineConfig({
  test: {
    globals: true
  }
})
