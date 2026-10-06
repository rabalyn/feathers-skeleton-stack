import { expect, type Page } from '@playwright/test'
import { origin } from '../playwright.config.js'

// Shared by the specs. `scripts/stack.sh e2e` creates the test accounts,
// and global-setup.ts gives them their roles before the run.

export interface Account {
  tuId: string
  password: string
}
export const ADMIN: Account = { tuId: 'ad01admn', password: 'admin-test-password' }
export const OPERATOR: Account = { tuId: 'op01oper', password: 'operator-test-password' }
export const USER: Account = { tuId: 'us01user', password: 'user-test-password' }

// The suite's own roles (ADR 0035), holding what the skeleton seeds
// `operator` and `user` with (ADR 0011), whatever a product's migrations have
// made of those: OPERATOR holds e2e-operator, USER and us02othr e2e-user.
export const E2E_ROLES = {
  'e2e-operator': {
    name: { de: 'E2E-Betrieb', en: 'E2E operations' },
    permissions: ['audit-events.read', 'directory.read', 'documents.all', 'sessions.read', 'sites.read', 'users.read']
  },
  'e2e-user': {
    name: { de: 'E2E-Benutzer', en: 'E2E user' },
    permissions: ['documents.own', 'sites.read']
  }
}
export const OPERATOR_ROLE = E2E_ROLES['e2e-operator'].name.de
export const USER_ROLE = E2E_ROLES['e2e-user'].name.de

export const IDP_ORIGIN = new RegExp(`^${origin('idp').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`)

interface Refreshed {
  accessToken: string
  user: { id: string }
}

// Logs in through the UI and returns what the app's startup refresh
// received, read off the wire: the page itself keeps the token in memory.
export const loginAs = async (page: Page, who: Account, path = '/') => {
  await page.goto(path)
  await page.getByRole('button', { name: 'Anmelden' }).click()
  await expect(page).toHaveURL(IDP_ORIGIN)
  await page.locator('#username').fill(who.tuId)
  await page.locator('#password').fill(who.password)
  const refreshed = page.waitForResponse(
    (response) => response.url().endsWith('/api/authentication') && response.request().method() === 'POST'
  )
  await page.locator('#kc-login').click()
  const response = await refreshed
  expect(response.status()).toBe(201)
  return (await response.json()) as Refreshed
}

// Asks `scripts/stack.sh e2e`, which reads the suite's output, to stop or
// start the e2e api (ADR 0015). Nothing else of the host is reachable.
export const stackAction = (action: 'stop api-e2e' | 'start api-e2e') => console.log(`stack-action: ${action}`)

export const nav = (page: Page) => page.locator('.q-drawer')
// The labels of the navigation, without the icons' ligature text.
export const navLabels = (page: Page) => nav(page).locator('.q-item__section--main')

// The skeleton's navigation, in its order (apps/web/src/layouts/MainLayout.vue).
const SKELETON_NAV = new Set([
  'Mein Profil',
  'Dokumente',
  'Gebäude',
  'Benutzer',
  'Rollen & Rechte',
  'Einstellungen',
  'Verzeichnis',
  'Sitzungen',
  'API-Tokens',
  'Aktivitätsprotokoll',
  'Datenanfragen',
  'E-Mail-Vorlagen',
  'Mailings',
  'Warteschlangen',
  'Systeminfo',
  'Architektur'
])

// The skeleton's links a page shows, in their order. A product's own links
// are left out, wherever they stand (ADR 0035).
export const skeletonNav = async (page: Page) =>
  (await navLabels(page).allTextContents()).map((label) => label.replace(/\s+/g, ' ').trim()).filter((label) => SKELETON_NAV.has(label))

// Exactly these of the skeleton's links, in this order, once the drawer
// settles.
export const expectNav = (page: Page, labels: string[]) => expect.poll(() => skeletonNav(page)).toEqual(labels)
