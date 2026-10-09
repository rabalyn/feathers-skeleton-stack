import type { Browser } from '@playwright/test'
import { APP } from '../playwright.config.js'

// The API as the run's break-glass account, the fixed admin (ADR 0008), for
// what a spec sets up as an admin would, as global-setup.ts does. Chromium
// alone maps the stack's host names and trusts the local CA, so the calls
// are made from a page of the app.
export interface AdminApi {
  // The admin's own record as the login returned it, with its permissions:
  // the whole catalogue and role management (ADR 0011).
  user: { id: string; permissions: string[] }
  call: <T = unknown>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>
  close: () => Promise<void>
}

export const adminApi = async (browser: Browser): Promise<AdminApi> => {
  const email = process.env.E2E_BREAKGLASS_EMAIL ?? ''
  const password = process.env.E2E_BREAKGLASS_PASSWORD ?? ''
  if (!email || !password) throw new Error('E2E_BREAKGLASS_EMAIL and E2E_BREAKGLASS_PASSWORD are not set; run the suite with scripts/stack.sh e2e')
  const context = await browser.newContext({ baseURL: APP })
  const page = await context.newPage()
  await page.goto('/login')
  const send = <T>(path: string, init: { method?: string; body?: unknown }, token?: string) =>
    page.evaluate(
      async ({ path, method, body, token }) => {
        const response = await fetch(`/api${path}`, {
          method,
          headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        })
        const text = await response.text()
        if (!response.ok) throw new Error(`${method ?? 'GET'} ${path}: ${response.status} ${text}`)
        return text ? JSON.parse(text) : null
      },
      { path, method: init.method, body: init.body, token }
    ) as Promise<T>
  const login = () =>
    send<{ accessToken: string; user: AdminApi['user'] }>('/authentication', { method: 'POST', body: { strategy: 'password', email, password } })
  let { accessToken, user } = await login()
  return {
    user,
    // An access token is short-lived (ADR 0010): a long spec logs in again.
    call: async <T>(path: string, init = {}) => {
      try {
        return await send<T>(path, init, accessToken)
      } catch (error) {
        if (!String(error).includes(': 401 ')) throw error
        ;({ accessToken, user } = await login())
        return send<T>(path, init, accessToken)
      }
    },
    close: async () => {
      await send('/authentication', { method: 'DELETE' }, accessToken).catch(() => undefined)
      await context.close()
    }
  }
}
