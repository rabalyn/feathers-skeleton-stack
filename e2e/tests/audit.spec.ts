import { expect, test } from '@playwright/test'
import { ADMIN, loginAs } from './support.js'

// The audit log pages on the server (ADR 0013): another page or page size
// fetches those events, and another filter starts on its first page.

test('the audit log pages through every event', async ({ page }) => {
  const { accessToken } = await loginAs(page, ADMIN, '/audit')

  // Fifty events newer than this login: a setting saved unchanged, fifty
  // times. The specs run one at a time, so nothing comes in between.
  await page.evaluate(async (token) => {
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const { data } = (await (await fetch('/api/settings', { headers })).json()) as { data: { key: string; value: unknown }[] }
    const { key, value } = data[0]!
    for (let i = 0; i < 50; i++) {
      const response = await fetch(`/api/settings/${key}`, { method: 'PATCH', headers, body: JSON.stringify({ value }) })
      if (!response.ok) throw new Error(`saving ${key} answered ${response.status}`)
    }
  }, accessToken)
  await page.reload()

  const table = page.locator('[data-test="audit-table"]')
  const rows = table.locator('tbody tr')
  const actions = rows.locator('td:nth-child(3)')
  const range = table.locator('.q-table__bottom-item').filter({ hasText: ' von ' })

  await expect(range).toHaveText(/^1–50 von \d+$/)
  await expect(actions).toHaveCount(50)
  await expect(actions.filter({ hasNotText: 'Einstellung geändert' })).toHaveCount(0)

  // Twenty-five a page: the first two pages hold them, the third starts
  // with the login before them.
  await table.locator('.q-table__select').click()
  await page.getByRole('option', { name: '25', exact: true }).click()
  await expect(table.locator('.q-table__select')).toContainText('25')
  await expect(range).toHaveText(/^1–25 von \d+$/)
  await expect(actions).toHaveCount(25)
  const next = table.getByRole('button').filter({ hasText: 'chevron_right' })
  await next.click()
  await expect(range).toHaveText(/^26–50 von \d+$/)
  await expect(actions).toHaveCount(25)
  await expect(actions.filter({ hasNotText: 'Einstellung geändert' })).toHaveCount(0)
  await next.click()
  await expect(range).toHaveText(/^51–\d+ von \d+$/)
  await expect(rows.first()).toContainText('Angemeldet')
  await expect(rows.first()).toContainText(ADMIN.tuId)

  // A filter shows its own first page.
  await table.getByLabel('Aktion').click()
  await page.getByRole('option', { name: 'Angemeldet', exact: true }).click()
  await expect(range).toHaveText(/^1–\d+ von \d+$/)
  await expect(rows.first()).toContainText(ADMIN.tuId)
  await expect(actions.filter({ hasNotText: 'Angemeldet' })).toHaveCount(0)
})
