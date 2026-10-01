import { expect, test, type Browser, type Page } from '@playwright/test'
import { USER, loginAs, nav, navLabels } from './support.js'

// Personal preferences (decided 2026-10-02, ADR 0014): a person arranges
// the navigation drawer, and the order is stored in the database, so it
// survives a reload and reaches their other browsers, live.

const DEFAULT = ['Mein Profil', 'Dokumente', 'Gebäude']

const session = async (browser: Browser): Promise<Page> => {
  const page = await (await browser.newContext()).newPage()
  await loginAs(page, USER)
  await expect(navLabels(page)).toHaveCount(DEFAULT.length)
  return page
}

const arrange = (page: Page) => nav(page).getByTestId('nav-arrange')

test('a person arranges the navigation, and it follows them', async ({ browser }) => {
  const page = await session(browser)
  const other = await session(browser)
  await expect(navLabels(page)).toHaveText(DEFAULT)

  // With the buttons: Gebäude up twice.
  await arrange(page).click()
  await nav(page).getByRole('button', { name: 'Gebäude nach oben' }).click()
  await nav(page).getByRole('button', { name: 'Gebäude nach oben' }).click()
  await expect(nav(page).getByRole('button', { name: 'Gebäude nach oben' })).toBeDisabled()
  await arrange(page).click()
  await expect(navLabels(page)).toHaveText(['Gebäude', 'Mein Profil', 'Dokumente'])

  // The other browser follows without a reload, and a reload keeps it.
  await expect(navLabels(other)).toHaveText(['Gebäude', 'Mein Profil', 'Dokumente'])
  await page.reload()
  await expect(navLabels(page)).toHaveText(['Gebäude', 'Mein Profil', 'Dokumente'])

  // By dragging: Dokumente onto Gebäude takes its place.
  await arrange(page).click()
  await nav(page).getByTestId('nav-item-documents').dragTo(nav(page).getByTestId('nav-item-sites'))
  await arrange(page).click()
  await expect(navLabels(page)).toHaveText(['Dokumente', 'Gebäude', 'Mein Profil'])
  await expect(navLabels(other)).toHaveText(['Dokumente', 'Gebäude', 'Mein Profil'])

  // The links still lead where they did.
  await nav(page).getByRole('link', { name: 'Gebäude' }).click()
  await expect(page).toHaveURL(/\/sites$/)

  // Back to the default, for the rest of the run.
  await arrange(page).click()
  await nav(page).getByTestId('nav-reset').click()
  await arrange(page).click()
  await expect(navLabels(page)).toHaveText(DEFAULT)
  await expect(navLabels(other)).toHaveText(DEFAULT)
})
