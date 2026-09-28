import { expect, test } from '@playwright/test'
import { ADMIN, OPERATOR, USER, loginAs, nav, navLabels } from './support.js'

// The queue view (ADR 0024): an admin sees worker-e2e's schedules, and a
// job run elsewhere shows on the open page without a reload (ADR 0012).
// Nobody else has the page.

test('an admin follows the queues live', async ({ browser, page }) => {
  await loginAs(page, ADMIN)
  await nav(page).getByRole('link', { name: 'Warteschlangen' }).click()
  await expect(page.locator('[data-test="queues-live"]')).toHaveText(/Live/)

  const maintenance = page.locator('[data-test="queue-maintenance-schedules"]')
  await expect(maintenance.getByRole('row').filter({ hasText: 'E-Mail-Ausgang prüfen' })).toContainText('alle 1 Minute')
  await expect(maintenance.getByRole('row').filter({ hasText: 'Aufbewahrungsfristen' })).toContainText('30 3 * * *')

  // The completed count stops at what the queue keeps, so the sign of a
  // live update is the time of the status shown.
  const exportsCard = page.locator('[data-test="queue-data-exports"]')
  const before = await exportsCard.getAttribute('data-updated')

  // A user asks for their data in another browser; the admin's page shows
  // the queue's new state.
  const other = await (await browser.newContext()).newPage()
  await loginAs(other, USER, '/profile')
  const myData = other.locator('[data-test="my-data"]')
  await myData.getByRole('button', { name: 'Meine Daten exportieren' }).click()
  await expect(myData.locator('[data-state="ready"]').first()).toBeVisible({ timeout: 30_000 })

  await expect(exportsCard).not.toHaveAttribute('data-updated', before!, { timeout: 10_000 })
})

test('an operator has no queue view', async ({ page }) => {
  await loginAs(page, OPERATOR)
  await expect(navLabels(page).filter({ hasText: 'Benutzer' })).toBeVisible()
  await expect(navLabels(page).filter({ hasText: 'Warteschlangen' })).toHaveCount(0)
  await page.goto('/queues')
  await expect(page).not.toHaveURL(/\/queues$/)
})
