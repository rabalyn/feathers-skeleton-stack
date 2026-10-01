import { expect, test } from '@playwright/test'
import { ADMIN, loginAs, nav } from './support.js'

// The Settings page explains every key (ADR 0025): an info icon beside it
// shows the text on hover and on keyboard focus, and the edit dialog
// repeats it.

const PURGE_HELP = 'Wie viele Tage eine gelöschte Datei im Speicher bleibt'

test('an admin reads what a setting means', async ({ page }) => {
  await loginAs(page, ADMIN)
  await nav(page).getByRole('link', { name: 'Einstellungen' }).click()
  await expect(page.getByRole('heading', { name: 'Einstellungen' })).toBeVisible()

  const info = page.getByRole('img', { name: 'Über objectPurgeDelayDays' })
  await info.hover()
  await expect(page.getByRole('tooltip')).toContainText(PURGE_HELP)
  await page.mouse.move(0, 0)
  await expect(page.getByRole('tooltip')).toHaveCount(0)

  await info.focus()
  await expect(page.getByRole('tooltip')).toContainText(PURGE_HELP)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('tooltip')).toHaveCount(0)

  await page.getByRole('row').filter({ hasText: 'objectPurgeDelayDays' }).getByRole('button', { name: 'Bearbeiten' }).click()
  await expect(page.getByRole('dialog')).toContainText(PURGE_HELP)
})
