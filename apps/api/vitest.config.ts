import { defineConfig } from 'vitest/config'

// Unit tests run anywhere. Integration tests need the stack and run in the
// `test` container (ADR 0015): scripts/stack.sh test.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts']
        }
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          exclude: ['test/integration/pooling.test.ts'],
          globalSetup: ['test/support/global-setup.ts'],
          setupFiles: ['test/support/worker-database.ts']
        }
      },
      {
        // Fills the test user's PgBouncer cap on purpose, which every other
        // integration file shares; run alone afterwards, it neither slows
        // them down nor is disturbed by them.
        test: {
          name: 'pooling',
          include: ['test/integration/pooling.test.ts'],
          sequence: { groupOrder: 1 }
        }
      }
    ]
  }
})
