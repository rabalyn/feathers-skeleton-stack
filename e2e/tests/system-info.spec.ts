import { expect, test } from '@playwright/test'
import { APP } from '../playwright.config.js'
import { ADMIN, OPERATOR, loginAs, nav, navLabels } from './support.js'

// The system-info page (ADR 0032): an admin sees what the stack runs, read
// live from Prometheus, Valkey and NetBox, the commit the api was built
// from and the public origin every link starts with. The e2e api runs with
// the update check off, so the suite never reaches the internet, and offers
// no button to run it now. Nobody else has the page.

test('an admin sees what runs', async ({ page }) => {
  await loginAs(page, ADMIN)
  await nav(page).getByRole('link', { name: 'Systeminfo' }).click()
  await expect(page.getByRole('heading', { name: 'Systeminfo' })).toBeVisible()

  await expect(page.locator('[data-test="system-info-app"]')).toContainText(/[0-9a-f]{12}/)
  // The e2e api's PUBLIC_ORIGIN is the origin the suite runs at.
  await expect(page.locator('[data-test="system-info-public-origin"]')).toContainText(APP)
  await expect(page.locator('[data-test="system-info-check"]')).toContainText('In dieser Installation abgeschaltet')
  // With the check off there is nothing to run now; reloading stays.
  await expect(page.getByRole('button', { name: 'Neu laden' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Jetzt prüfen' })).toHaveCount(0)

  for (const id of ['postgresql', 'pgbouncer', 'valkey', 'netbox', 'node']) {
    await expect(page.locator(`[data-test="component-${id}-running"]`), id).toHaveText(/\d+\.\d+/)
  }
  await expect(page.locator('[data-test="component-postgresql"]')).toContainText('docker.io/library/postgres')
  // Nothing reports OpenBao's version; the pinned one is all there is.
  await expect(page.locator('[data-test="component-openbao-running"]')).toHaveText('nicht gemeldet')
  await expect(page.locator('[data-test="component-postgresql-running"]')).not.toContainText('weicht ab')
})

test('an operator has no system-info page', async ({ page }) => {
  await loginAs(page, OPERATOR)
  await expect(navLabels(page).filter({ hasText: 'Benutzer' })).toBeVisible()
  await expect(navLabels(page).filter({ hasText: 'Systeminfo' })).toHaveCount(0)
  await page.goto('/system-info')
  await expect(page).not.toHaveURL(/\/system-info$/)
})
