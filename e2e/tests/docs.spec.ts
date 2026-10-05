import { expect, test } from '@playwright/test'
import { ADMIN, OPERATOR, loginAs, nav, navLabels } from './support.js'

// The architecture page (ADR 0019): a tab per diagram page with its Mermaid
// diagrams drawn, and the ADRs with a search. `docs.read` is the admin's
// alone (ADR 0011); nobody else has the page.

test('an admin reads the diagrams and searches the ADRs', async ({ page }) => {
  await loginAs(page, ADMIN)
  await nav(page).getByRole('link', { name: 'Architektur' }).click()
  await expect(page.getByRole('heading', { name: 'Architektur', level: 1 })).toBeVisible()

  // The diagrams index first, its pages in its order.
  const tabs = page.locator('[data-test="docs-tabs"]').getByRole('tab')
  await expect(tabs.first()).toHaveText('Übersicht')
  await expect(tabs.nth(1)).toHaveText('Topology')
  await expect(page.locator('[data-test="doc-diagrams-readme"]')).toContainText('They decide nothing')

  // A diagram page, drawn under the document CSP (ADR 0018).
  await page.locator('[data-test="docs-tab-diagrams-topology"]').click()
  await expect(page).toHaveURL(/\/docs\?page=diagrams-topology$/)
  const topology = page.locator('[data-test="doc-diagrams-topology"]')
  await expect(topology.locator('.doc-mermaid.drawn svg').first()).toBeVisible()
  await expect(topology.locator('.doc-mermaid.failed')).toHaveCount(0)

  // A link to an ADR opens it on the ADRs tab, at its heading.
  await page.locator('[data-test="docs-tab-diagrams-readme"]').click()
  await page.locator('[data-test="doc-diagrams-readme"]').getByRole('link', { name: '0019' }).click()
  await expect(page).toHaveURL(/\/docs\?page=0019-adr-convention#diagrams$/)
  await expect(page.locator('[data-test="docs-tab-adrs"]')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('[data-test="doc-0019-adr-convention"]').getByRole('heading', { name: 'Diagrams' })).toBeInViewport()

  // Every word, in any case; the page with them in its title first.
  await page.locator('[data-test="docs-search"]').fill('PgBouncer transaction')
  const list = page.locator('[data-test="docs-adr-list"]')
  await expect(list.locator('.q-item').first()).toHaveAttribute('data-test', 'docs-adr-0004-pgbouncer-pools')
  await list.locator('[data-test="docs-adr-0004-pgbouncer-pools"]').click()
  await expect(page.locator('[data-test="doc-0004-pgbouncer-pools"]').getByRole('heading', { level: 1 })).toContainText('PgBouncer')

  await page.locator('[data-test="docs-search"]').fill('no-such-word-anywhere')
  await expect(page.locator('[data-test="docs-no-match"]')).toBeVisible()
})

test('an operator has no architecture page', async ({ page }) => {
  await loginAs(page, OPERATOR)
  await expect(navLabels(page).filter({ hasText: 'Benutzer' })).toBeVisible()
  await expect(navLabels(page).filter({ hasText: 'Architektur' })).toHaveCount(0)
  await page.goto('/docs')
  await expect(page).not.toHaveURL(/\/docs/)
})
