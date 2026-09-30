import { expect, test, type Page } from '@playwright/test'
import { ADMIN, OPERATOR, loginAs, nav } from './support.js'

// API tokens (ADR 0029): an admin creates one on the page, sees it once,
// reads the API with it from outside the browser, and revokes it, after
// which it is refused. Without api-tokens.create, as operators are seeded,
// the page is not offered.

// A script's call: from a context of its own, with no cookie and no login,
// only the token. Made from a page on the app's origin, since only Chromium
// maps the host names to nginx and trusts the local CA.
const callWith = (script: Page, token: string, path: string) =>
  script.evaluate(
    async ([url, bearer]) => {
      const response = await fetch(url, { headers: { authorization: `Bearer ${bearer}` } })
      return { status: response.status, body: response.ok ? ((await response.json()) as { total?: number }) : null }
    },
    [path, token]
  )

test('an admin creates a token, uses it over REST and revokes it', async ({ page, browser }) => {
  await loginAs(page, ADMIN)
  await nav(page).getByRole('link', { name: 'API-Tokens' }).click()

  await page.getByRole('button', { name: 'Neues Token' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Name').fill('Auswertung')
  // Excluded permissions are not offered, even to an admin.
  await expect(dialog.getByRole('checkbox', { name: 'Einstellungen ändern' })).toHaveCount(0)
  await dialog.getByRole('checkbox', { name: 'Alle Personen sehen' }).click()
  await dialog.getByRole('button', { name: 'Token erstellen' }).click()

  const value = page.locator('input[data-test="api-token-value"]')
  await expect(value).toHaveValue(/^apt_/)
  const token = await value.inputValue()
  await page.getByRole('button', { name: 'Fertig' }).click()

  const row = page.locator('[data-test="api-tokens-table"] tbody tr').filter({ hasText: 'Auswertung' })
  await expect(row).toContainText(`apt_…${token.slice(-4)}`)
  await expect(row).toContainText('Alle Personen sehen')
  await expect(row).toContainText('Nie')

  const context = await browser.newContext()
  const script = await context.newPage()
  await script.goto('/api/ping')
  const users = await callWith(script, token, '/api/users')
  expect(users.status).toBe(200)
  expect(users.body?.total).toBeGreaterThan(1)
  expect((await callWith(script, token, '/api/settings')).status).toBe(403)

  await row.getByRole('button', { name: 'Widerrufen' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Widerrufen' }).click()
  await expect(page.getByText('Token widerrufen')).toBeVisible()
  await expect(row).toHaveCount(0)
  expect((await callWith(script, token, '/api/users')).status).toBe(401)
  await context.close()
})

test('an operator is not offered API tokens', async ({ page }) => {
  await loginAs(page, OPERATOR)
  await expect(nav(page)).not.toContainText('API-Tokens')
  await page.goto('/api-tokens')
  await expect(page).toHaveURL(/\/profile$/)
})
