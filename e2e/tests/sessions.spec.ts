import { expect, test, type Browser, type Page } from '@playwright/test'
import { ADMIN, OPERATOR, USER, loginAs, nav, navLabels, type Account } from './support.js'

// Who is logged in (ADR 0010, 0011): admins and operators see every active
// session, live; operators see no browser and end none; admins end anyone's,
// and that browser is back at the login at once. Users see no sessions.

// A browser of its own for `who`, logged in, and the session it holds.
const loggedIn = async (browser: Browser, who: Account, path = '/'): Promise<{ page: Page; sessionId: string }> => {
  const page = await (await browser.newContext()).newPage()
  const { accessToken } = await loginAs(page, who, path)
  const payload = JSON.parse(Buffer.from(accessToken.split('.')[1]!, 'base64url').toString()) as { sid: string }
  return { page, sessionId: payload.sid }
}

const sessionRow = (page: Page, sessionId: string) =>
  page.locator('[data-test="sessions-table"] tbody tr').filter({ has: page.locator(`[data-session="${sessionId}"]`) })

test('a user sees no sessions', async ({ browser }) => {
  const { page } = await loggedIn(browser, USER, '/profile')
  await expect(navLabels(page)).toHaveText(['Mein Profil', 'Dokumente', 'Gebäude'])
  await expect(page.locator('[data-test="session-list"]')).toHaveCount(0)
  await page.goto('/sessions')
  await expect(page).toHaveURL(/\/profile$/)
})

test('an operator sees logins and logouts live, without the browser, and ends none', async ({ browser }) => {
  const { page, sessionId: own } = await loggedIn(browser, OPERATOR)
  await nav(page).getByRole('link', { name: 'Sitzungen' }).click()
  // Their own session is marked, and has no end button either.
  await expect(sessionRow(page, own)).toContainText('Dieser Browser')

  // A login elsewhere appears without a reload …
  const user = await loggedIn(browser, USER)
  const row = sessionRow(page, user.sessionId)
  await expect(row).toContainText('us01user')
  await expect(row.getByRole('cell').nth(1)).toHaveText('—')
  await expect(page.getByRole('button', { name: 'Sitzung beenden' })).toHaveCount(0)

  // … and a logout disappears the same way.
  await user.page.getByRole('button', { name: 'Abmelden' }).click()
  await expect(user.page).toHaveURL(/\/login/)
  await expect(row).toHaveCount(0)
})

test('an admin ends a user’s session from the users page', async ({ browser }) => {
  const user = await loggedIn(browser, USER)
  const { page } = await loggedIn(browser, ADMIN)

  await nav(page).getByRole('link', { name: 'Benutzer' }).click()
  await page.getByRole('row').filter({ hasText: 'us01user' }).getByRole('link', { name: 'Sitzungen' }).click()
  await expect(page).toHaveURL(/\/sessions\?userId=/)
  await expect(page.locator('[data-test="sessions-filter"]')).toContainText('us01user')
  // Filtered to that person: every row is theirs, with the browser shown.
  const rows = page.locator('[data-test="sessions-table"] tbody tr')
  await expect(rows.first()).toBeVisible()
  await expect(rows.filter({ hasNotText: 'us01user' })).toHaveCount(0)
  const row = sessionRow(page, user.sessionId)
  await expect(row.getByRole('cell').nth(1)).not.toHaveText('—')

  await row.getByRole('button', { name: 'Sitzung beenden' }).click()
  await expect(page.getByText('Sitzung beendet')).toBeVisible()
  await expect(row).toHaveCount(0)
  await expect(user.page).toHaveURL(/\/login/)
})
