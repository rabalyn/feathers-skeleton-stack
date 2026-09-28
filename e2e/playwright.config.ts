import { defineConfig, devices } from '@playwright/test'

// End-to-end tests (ADR 0015), run in the `e2e` container against the real
// stack over real TLS. Chromium maps the public host names to the nginx
// container and trusts the local CA through its NSS store (imported by the
// container's entrypoint); certificate errors are never ignored.

// The e2e origin: api-e2e on a database of its own (ADR 0015).
export const APP = process.env.E2E_APP_ORIGIN ?? 'https://e2e.localhost:8443'

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: APP,
    ignoreHTTPSErrors: false,
    trace: 'retain-on-failure',
    launchOptions: {
      args: [`--host-resolver-rules=${process.env.E2E_HOST_RESOLVER_RULES ?? ''}`]
    }
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chromium' } }]
})
