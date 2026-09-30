import { expect, test } from '@playwright/test'
import { ADMIN, OPERATOR, loginAs, nav, navLabels } from './support.js'

// Roles and permissions (ADR 0011): an admin creates a role, grants it a
// permission, previews it, and deletes it once nobody holds it. Nobody else
// reaches the page.

test('an admin creates, grants, previews and deletes a role', async ({ page }) => {
  await loginAs(page, ADMIN)
  await nav(page).getByRole('link', { name: 'Rollen & Rechte' }).click()

  // The fixed and the built-in roles, as columns.
  const header = page.locator('thead')
  await expect(header).toContainText('Administration')
  await expect(header).toContainText('Betrieb')
  await expect(header).toContainText('Benutzer')
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

  // The preview shows the navigation as the role would: a role without
  // documents has none, but its activity log.
  await page.locator('th').filter({ hasText: 'Prüfung' }).getByRole('button', { name: 'Vorschau' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Vorschau als „Prüfung“' })).toBeVisible()
  await expect(navLabels(page)).toHaveText(['Mein Profil', 'Aktivitätsprotokoll'])
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
