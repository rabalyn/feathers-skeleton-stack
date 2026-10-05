import { defineConfig, devices } from '@playwright/test'

// End-to-end tests (ADR 0015), run in the `e2e` container against the real
// stack over real TLS. Chromium maps the public host names to the nginx
// container and trusts the local CA through its NSS store (imported by the
// container's entrypoint); certificate errors are never ignored.

// The e2e origin: api-e2e on a database of its own (ADR 0015). compose.yaml
// builds it from product.env (ADR 0035): https://e2e.<project>.localhost:<port>.
if (!process.env.E2E_APP_ORIGIN) throw new Error('E2E_APP_ORIGIN is not set; run the suite with scripts/stack.sh e2e')
export const APP = process.env.E2E_APP_ORIGIN

// The origin of another public host name of the same stack: `origin('idp')`.
export const origin = (name: string) => APP.replace('://e2e.', `://${name}.`)

// The plain HTTP port, which only redirects.
export const HTTP_PORT = process.env.E2E_HTTP_PORT ?? ''

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
