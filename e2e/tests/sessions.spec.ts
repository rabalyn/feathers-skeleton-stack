import { expect, test, type Browser, type Page } from '@playwright/test'
import { ADMIN, OPERATOR, USER, loginAs, nav, type Account } from './support.js'

// Sessions (ADR 0010, 0011): everyone sees where they are logged in and ends
// the other logins; operators see every session but not its browser; admins
// end anyone's. An ended session's browser is back at the login at once.

// A browser of its own for `who`, logged in, and the session it holds.
const loggedIn = async (browser: Browser, who: Account, path = '/profile'): Promise<{ page: Page; sessionId: string }> => {
  const page = await (await browser.newContext()).newPage()
  const { accessToken } = await loginAs(page, who, path)
  const payload = JSON.parse(Buffer.from(accessToken.split('.')[1]!, 'base64url').toString()) as { sid: string }
  return { page, sessionId: payload.sid }
}

test('a user sees where they are logged in and ends another login', async ({ browser }) => {
  const here = await loggedIn(browser, USER)
  const there = await loggedIn(browser, USER)

  await here.page.reload()
  const list = here.page.locator('[data-test="session-list"]')
  // This browser's session is marked, and ends with the normal logout.
  const current = list.locator(`[data-session="${here.sessionId}"]`)
  await expect(current).toHaveAttribute('data-current', 'true')
  await expect(current).toContainText('Dieser Browser')
  await expect(current.getByRole('button', { name: 'Abmelden' })).toBeVisible()

  const other = list.locator(`[data-session="${there.sessionId}"]`)
  await other.getByRole('button', { name: 'Sitzung beenden' }).click()
  await expect(here.page.getByText('Sitzung beendet')).toBeVisible()
  await expect(other).toHaveCount(0)
  // The other browser loses its session without doing anything.
  await expect(there.page).toHaveURL(/\/login/)
  // This one keeps its own.
  await here.page.reload()
  await expect(current).toBeVisible()
})

test('an operator sees every session but not its browser, and ends none of others', async ({ browser }) => {
  const user = await loggedIn(browser, USER)
  const { page } = await loggedIn(browser, OPERATOR, '/')

  await nav(page).getByRole('link', { name: 'Sitzungen' }).click()
  const theirs = page.getByRole('row').filter({ hasText: 'us01user' })
  await expect(theirs.first()).toBeVisible()
  for (const row of await theirs.all()) {
    await expect(row.getByRole('cell').nth(1)).toHaveText('—')
  }
  await expect(theirs.getByRole('button', { name: 'Sitzung beenden' })).toHaveCount(0)
  await expect(page.locator(`[data-session="${user.sessionId}"]`)).toHaveCount(0)
})

test('an admin ends a user’s session from the users page', async ({ browser }) => {
  const user = await loggedIn(browser, USER)
  const { page } = await loggedIn(browser, ADMIN, '/')

  await nav(page).getByRole('link', { name: 'Benutzer' }).click()
  await page.getByRole('row').filter({ hasText: 'us01user' }).getByRole('link', { name: 'Sitzungen' }).click()
  await expect(page).toHaveURL(/\/sessions\?userId=/)
  await expect(page.locator('[data-test="sessions-filter"]')).toContainText('us01user')
  // Filtered to that person: every row is theirs, with the browser shown.
  const rows = page.locator('[data-test="sessions-table"] tbody tr')
  await expect(rows.first()).toBeVisible()
  await expect(rows.filter({ hasNotText: 'us01user' })).toHaveCount(0)
  await expect(rows.first().getByRole('cell').nth(1)).not.toHaveText('—')

  await page.locator(`[data-session="${user.sessionId}"]`).click()
  await expect(page.getByText('Sitzung beendet')).toBeVisible()
  await expect(page.locator(`[data-session="${user.sessionId}"]`)).toHaveCount(0)
  await expect(user.page).toHaveURL(/\/login/)
})
