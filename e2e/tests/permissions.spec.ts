import { expect, test } from '@playwright/test'
import { ADMIN, OPERATOR, USER, loginAs, nav, navLabels, OPERATOR_ROLE, skeletonNav } from './support.js'

// Roles and permissions (ADR 0011): an admin creates a role, grants it a
// permission, previews it, and deletes it once nobody holds it. Nobody else
// reaches the page.

test('an admin creates, grants, previews and deletes a role', async ({ page }) => {
  await loginAs(page, ADMIN)
  await nav(page).getByRole('link', { name: 'Rollen & Rechte' }).click()

  // The fixed, the built-in and the suite's own roles, as columns; a product
  // may rename the built-in ones (ADR 0035), so they are known by their kind.
  const header = page.locator('thead')
  await expect(header).toContainText('Administration')
  await expect(header).toContainText('Fest: stets jedes Recht')
  await expect(header).toContainText('Haben alle Angemeldeten ohne Zuweisung')
  await expect(header.getByText('Eingebaut: änderbar, nicht löschbar')).toHaveCount(2)
  await expect(header).toContainText(OPERATOR_ROLE)
  await expect(page.getByRole('checkbox', { name: 'Administration: Einstellungen ändern' })).toBeDisabled()

  await page.getByRole('button', { name: 'Neue Rolle' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Schlüssel').fill('pruefung')
  await dialog.getByLabel('Name (Deutsch)').fill('Prüfung')
  await dialog.getByLabel('Name (English)').fill('Review')
  await dialog.getByRole('button', { name: 'Speichern' }).click()
  await expect(page.getByText('Rolle angelegt')).toBeVisible()
  await expect(header).toContainText('Prüfung')

  const grant = page.getByRole('checkbox', { name: 'Prüfung: Alle Aktivitäten sehen' })
  await expect(grant).not.toBeChecked()
  await grant.click()
  await expect(grant).toBeChecked()
  await page.reload()
  await expect(page.getByRole('checkbox', { name: 'Prüfung: Alle Aktivitäten sehen' })).toBeChecked()

  // A permission includes what it requires (ADR 0037): ticked and locked
  // with it, and gone with it.
  await expect(page.locator('[data-requires="locations.create"]')).toHaveText('Schließt ein: Räume sehen')
  const rooms = page.getByRole('checkbox', { name: 'Prüfung: Räume anlegen' })
  const roomsRead = page.getByRole('checkbox', { name: 'Prüfung: Räume sehen' })
  const sitesRead = page.getByRole('checkbox', { name: 'Prüfung: Gebäude sehen' })
  await rooms.click()
  await expect(rooms).toBeChecked()
  await expect(roomsRead).toBeChecked()
  await expect(roomsRead).toBeDisabled()
  await expect(sitesRead).toBeChecked()
  await expect(sitesRead).toBeDisabled()
  await expect(page.locator('td').filter({ has: sitesRead }).locator('[data-test="included-by"]')).toHaveText('Enthalten in: Räume anlegen')
  await rooms.click()
  await expect(rooms).not.toBeChecked()
  await expect(sitesRead).not.toBeChecked()
  await expect(sitesRead).toBeEnabled()

  // The preview shows the navigation as the role would: a role without
  // documents has none, but its activity log. What else it shows comes from
  // `everyone`, which a product may extend (ADR 0035).
  await page.locator('th').filter({ hasText: 'Prüfung' }).getByRole('button', { name: 'Vorschau' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Vorschau als „Prüfung“' })).toBeVisible()
  await expect.poll(() => skeletonNav(page)).toContain('Aktivitätsprotokoll')
  expect(await skeletonNav(page)).not.toContain('Dokumente')
  await page.getByRole('button', { name: 'Vorschau beenden' }).click()
  await expect(page).toHaveURL(/\/permissions$/)
  await expect(navLabels(page)).toContainText(['Rollen & Rechte'])

  await page.locator('th').filter({ hasText: 'Prüfung' }).getByRole('button', { name: 'Löschen' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Löschen' }).click()
  await expect(page.getByText('Rolle gelöscht')).toBeVisible()
  await expect(header).not.toContainText('Prüfung')
})

test('an operator does not reach the permissions page', async ({ page }) => {
  await loginAs(page, OPERATOR)
  await expect(nav(page)).not.toContainText('Rollen & Rechte')
  await page.goto('/permissions')
  await expect(page).toHaveURL(/\/profile$/)
})

// ADR 0011, decided 2026-10-01: what everyone holds is the `everyone` role,
// editable like any other; the own export is the fixed core and stays. A
// product may have withdrawn own activity already (ADR 0035): the test
// grants it first, and puts back what it found.
test('an admin withdraws own activity from everyone, and a user loses it but keeps the export', async ({ page, browser }) => {
  await loginAs(page, ADMIN)
  await nav(page).getByRole('link', { name: 'Rollen & Rechte' }).click()
  const own = page.getByRole('checkbox', { name: 'Alle Angemeldeten: Eigene Aktivitäten' })
  await expect(own).toBeEnabled()
  const granted = await own.isChecked()
  if (!granted) {
    await own.click()
    await expect(own).toBeChecked()
  }
  await own.click()
  await expect(own).not.toBeChecked()

  const user = await (await browser.newContext()).newPage()
  try {
    await loginAs(user, USER)
    await expect(user.getByRole('heading', { name: 'Meine Daten' })).toBeVisible()
    await expect(user.getByRole('heading', { name: 'Meine Aktivitäten' })).toHaveCount(0)
  } finally {
    if (granted) {
      await own.click()
      await expect(own).toBeChecked()
    }
    await user.context().close()
  }
})
