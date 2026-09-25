import { expect, test, type Browser, type Page } from '@playwright/test'
import { ADMIN, OPERATOR, loginAs, nav, navLabels, type Account } from './support.js'

// Real-time updates over the WebSocket (ADR 0012, 0015): an operator's open
// users page follows an admin's changes without a reload, and a role change
// takes the operator's rights away at once.

const session = async (browser: Browser, who: Account): Promise<Page> => {
  const page = await (await browser.newContext()).newPage()
  await loginAs(page, who)
  await nav(page).getByRole('link', { name: 'Benutzer' }).click()
  return page
}

const row = (page: Page, tuId: string) => page.getByRole('row').filter({ hasText: tuId })

test('an operator sees an admin’s changes live, and loses the page when demoted', async ({ browser }) => {
  const admin = await session(browser, ADMIN)
  const operator = await session(browser, OPERATOR)
  const watched = row(operator, 'us01user').getByRole('switch')
  await expect(watched).toBeChecked()

  // The admin disables an account; the operator's page shows it unreloaded.
  await row(admin, 'us01user').getByRole('switch').click()
  await expect(admin.getByText('Gespeichert')).toBeVisible()
  await expect(watched).not.toBeChecked()
  await row(admin, 'us01user').getByRole('switch').click()
  await expect(watched).toBeChecked()

  // Demoted, the operator's socket is closed; the page re-authenticates
  // under the new role and leaves what that role may not see.
  await row(admin, 'op01oper').getByRole('combobox', { name: 'Rolle' }).click()
  await admin.getByRole('option', { name: 'Benutzer' }).click()
  await expect(operator).toHaveURL(/\/profile$/)
  await expect(operator.locator('[data-field="role"]')).toHaveText('Benutzer')
  await expect(navLabels(operator)).toHaveText(['Mein Profil'])

  // Promoted back, for the rest of the run.
  await row(admin, 'op01oper').getByRole('combobox', { name: 'Rolle' }).click()
  await admin.getByRole('option', { name: 'Betrieb' }).click()
  await expect(navLabels(operator)).toHaveText(['Mein Profil', 'Benutzer', 'Verzeichnis'])
})
