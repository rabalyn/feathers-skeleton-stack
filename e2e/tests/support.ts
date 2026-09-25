import { expect, type Page } from '@playwright/test'

// Shared by the specs. `scripts/stack.sh e2e` gives the test accounts their
// roles before the run.

export interface Account {
  tuId: string
  password: string
}
export const ADMIN: Account = { tuId: 'ad01admn', password: 'admin-test-password' }
export const OPERATOR: Account = { tuId: 'op01oper', password: 'operator-test-password' }
export const USER: Account = { tuId: 'us01user', password: 'user-test-password' }

export const IDP_ORIGIN = /^https:\/\/idp\.localhost:8443\//

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

export const nav = (page: Page) => page.locator('.q-drawer')
// The labels of the navigation, without the icons' ligature text.
export const navLabels = (page: Page) => nav(page).locator('.q-item__section--main')
