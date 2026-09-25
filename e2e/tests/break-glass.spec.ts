import { expect, test } from '@playwright/test'
import { nav, navLabels } from './support.js'

// The break-glass login (ADR 0008) on its own, unlinked route. The account
// is made by the bootstrap command in `scripts/stack.sh up`, which hands its
// local password to this run.

const EMAIL = process.env.E2E_BREAKGLASS_EMAIL ?? ''
const PASSWORD = process.env.E2E_BREAKGLASS_PASSWORD ?? ''

test('the break-glass account logs in with its password and administers', async ({ page }) => {
  expect(EMAIL, 'run through scripts/stack.sh e2e').not.toBe('')
  expect(PASSWORD, 'run through scripts/stack.sh e2e').not.toBe('')

  // Nothing on the normal login page leads there.
  await page.goto('/login')
  await expect(page.getByRole('button', { name: 'Anmelden' })).toBeVisible()
  await expect(page.locator('a[href*="break-glass"]')).toHaveCount(0)

  await page.goto('/break-glass')
  await page.getByLabel('E-Mail').fill(EMAIL)
  await page.getByLabel('Passwort').fill('not-the-password')
  await page.getByRole('button', { name: 'Anmelden' }).click()
  await expect(page.getByRole('alert')).toHaveText('E-Mail oder Passwort ist falsch.')
  await expect(page.getByLabel('Passwort')).toHaveValue('')

  await page.getByLabel('Passwort').fill(PASSWORD)
  await page.getByRole('button', { name: 'Anmelden' }).click()
  await expect(page).toHaveURL(/\/profile$/)
  await expect(page.locator('[data-field="email"]')).toHaveText(EMAIL)
  await expect(page.locator('[data-field="tuId"]')).toHaveText('')
  await expect(page.locator('[data-field="role"]')).toHaveText('Administration')
  await expect(navLabels(page)).toContainText(['Einstellungen'])

  // A reload restores the session from the cookie, as for a SAML login.
  await page.reload()
  await expect(page.locator('[data-field="email"]')).toHaveText(EMAIL)
  await nav(page).getByRole('link', { name: 'Einstellungen' }).click()
  await expect(page).toHaveURL(/\/settings$/)

  // No IdP session to end: logout returns straight to the app.
  await page.getByRole('button', { name: 'Abmelden' }).click()
  await expect(page).toHaveURL(/\/login/)
})
