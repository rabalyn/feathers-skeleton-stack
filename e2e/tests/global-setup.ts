import { chromium, type FullConfig } from '@playwright/test'
import { APP } from '../playwright.config.js'
import { E2E_ROLES } from './support.js'

// Tests own their roles (ADR 0035): a product may change what the seeded
// roles grant, so the suite's accounts hold roles of its own, as the
// break-glass admin assigns them before the run. `everyone` is left alone:
// a product's specs share this database. ad01admn keeps the fixed `admin`,
// which `scripts/stack.sh e2e` gave it.

// The account each test role goes to.
const HOLDERS: Record<string, keyof typeof E2E_ROLES> = {
  op01oper: 'e2e-operator',
  us01user: 'e2e-user',
  us02othr: 'e2e-user'
}

export default async function globalSetup(config: FullConfig) {
  const email = process.env.E2E_BREAKGLASS_EMAIL ?? ''
  const password = process.env.E2E_BREAKGLASS_PASSWORD ?? ''
  if (!email || !password) throw new Error('E2E_BREAKGLASS_EMAIL and E2E_BREAKGLASS_PASSWORD are not set; run the suite with scripts/stack.sh e2e')
  // Chromium alone maps the stack's host names and trusts the local CA
  // (playwright.config.ts), so the calls are made from a page of the app.
  const { channel, launchOptions } = config.projects[0]?.use ?? {}
  const browser = await chromium.launch({ ...launchOptions, channel })
  try {
    const page = await browser.newPage({ baseURL: APP })
    await page.goto('/login')
    const failure = await page.evaluate(
      async ({ email, password, roles, holders }) => {
        const call = async (path: string, init: RequestInit = {}, token?: string) => {
          const response = await fetch(`/api${path}`, {
            ...init,
            headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }
          })
          const text = await response.text()
          if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${response.status} ${text}`)
          return text ? JSON.parse(text) : null
        }
        try {
          const { accessToken } = await call('/authentication', { method: 'POST', body: JSON.stringify({ strategy: 'password', email, password }) })
          const roleIds: Record<string, string> = {}
          for (const [key, role] of Object.entries(roles)) {
            const existing = (await call(`/roles?key=${key}`, {}, accessToken)).data[0]
            roleIds[key] = existing
              ? (await call(`/roles/${existing.id}`, { method: 'PATCH', body: JSON.stringify(role) }, accessToken)).id
              : (await call('/roles', { method: 'POST', body: JSON.stringify({ key, ...role }) }, accessToken)).id
          }
          for (const [tuId, key] of Object.entries(holders)) {
            const user = (await call(`/users?tuId=${tuId}`, {}, accessToken)).data[0]
            if (!user) throw new Error(`no account ${tuId}`)
            await call(`/user-roles/${user.id}`, { method: 'PATCH', body: JSON.stringify({ roleIds: [roleIds[key]] }) }, accessToken)
          }
          await call('/authentication', { method: 'DELETE' }, accessToken)
          return null
        } catch (error) {
          return String(error)
        }
      },
      { email, password, roles: E2E_ROLES, holders: HOLDERS }
    )
    if (failure) throw new Error(`giving the test accounts their roles failed: ${failure}`)
  } finally {
    await browser.close()
  }
}
