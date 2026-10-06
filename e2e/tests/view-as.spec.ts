import { expect, test } from '@playwright/test'
import { ADMIN, loginAs, nav, navLabels, expectNav, USER_ROLE } from './support.js'

// Read-only view-as (ADR 0028): an admin sees the application as a user
// does, can change nothing there, and returns to their own view.

test('an admin views the application as a user, read-only, and ends it', async ({ page }) => {
  await loginAs(page, ADMIN)
  await nav(page).getByRole('link', { name: 'Benutzer' }).click()
  await page.getByRole('row').filter({ hasText: 'us01user' }).getByRole('button', { name: 'Als diese Person ansehen' }).click()

  const banner = page.getByRole('status').filter({ hasText: 'Sie sehen die Anwendung als us01user' })
  await expect(banner).toBeVisible()
  await expect(page).toHaveURL(/\/profile$/)
  await expect(page.locator('[data-field="tuId"]')).toHaveText('us01user')
  await expect(page.locator('[data-field="role"]')).toHaveText(USER_ROLE)
  // What the user sees, and nothing to change: no picture upload, no export.
  await expectNav(page, ['Mein Profil', 'Dokumente', 'Gebäude'])
  await expect(page.locator('[data-test="avatar-input"]')).toHaveCount(0)
  await expect(page.locator('[data-test="my-data"]')).toHaveCount(0)

  await nav(page).getByRole('link', { name: 'Dokumente' }).click()
  await expect(page.locator('[data-test="document-title"]')).toHaveCount(0)

  await banner.getByRole('button', { name: 'Ansicht beenden' }).click()
  await expect(banner).toHaveCount(0)
  await expect(page).toHaveURL(/\/users$/)
  await expect(navLabels(page)).toContainText(['Rollen & Rechte'])
})
