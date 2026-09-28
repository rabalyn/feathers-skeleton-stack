import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Unit tests that need no stack (ADR 0015); they run in the CI image.
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { include: ['test/**/*.test.ts'] }
})
