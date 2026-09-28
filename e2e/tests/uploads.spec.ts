import { expect, test, type Browser, type Page } from '@playwright/test'
import { OPERATOR, USER, loginAs, nav, type Account } from './support.js'

// Uploads through the real UI (ADR 0020): a document goes up through
// Nginx, the api and Garage, an operator sees it arrive live (ADR 0012), it
// comes back byte for byte, and a file that is not what its type says is
// refused. The avatar is fetched with the token and shown from a blob.
//
// Quasar puts extra attributes, data-test included, on the native input of
// q-input and q-file.

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n')
// A real 1×1 red pixel, so the browser can decode it.
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cfc0f01f00050001ff89993d1d0000000049454e44ae426082',
  'hex'
)

const documentsOf = async (browser: Browser, who: Account): Promise<Page> => {
  const page = await (await browser.newContext()).newPage()
  await loginAs(page, who)
  await nav(page).getByRole('link', { name: 'Dokumente' }).click()
  return page
}

const row = (page: Page, text: string) => page.getByRole('row').filter({ hasText: text })

test('a user uploads a document, an operator sees it live, it downloads intact, and is deleted', async ({ browser }) => {
  const user = await documentsOf(browser, USER)
  const operator = await documentsOf(browser, OPERATOR)

  await user.locator('input[data-test="document-title"]').fill('Quartalsbericht')
  await user.locator('input[type="file"][data-test="document-file"]').setInputFiles({
    name: 'Bericht Q3 ä.pdf',
    mimeType: 'application/pdf',
    buffer: PDF
  })
  await user.getByRole('button', { name: 'Hochladen' }).click()
  await expect(user.getByText('Dokument hochgeladen')).toBeVisible()
  await expect(row(user, 'Quartalsbericht')).toContainText('Bericht Q3 ä.pdf')

  // The operator's open page shows it, with its owner, unreloaded.
  await expect(row(operator, 'Quartalsbericht')).toContainText('us01user')

  const downloaded = operator.waitForEvent('download')
  await row(operator, 'Quartalsbericht').getByRole('button', { name: 'Herunterladen' }).click()
  const download = await downloaded
  expect(download.suggestedFilename()).toBe('Bericht Q3 ä.pdf')
  const chunks: Buffer[] = []
  for await (const chunk of (await download.createReadStream()) as AsyncIterable<Buffer>) chunks.push(chunk)
  expect(Buffer.concat(chunks).equals(PDF)).toBe(true)

  await row(user, 'Quartalsbericht').getByRole('button', { name: 'Löschen' }).click()
  await user.getByRole('dialog').getByRole('button', { name: 'Löschen' }).click()
  await expect(row(user, 'Quartalsbericht')).toHaveCount(0)
  await expect(row(operator, 'Quartalsbericht')).toHaveCount(0)
})

test('a file whose bytes are not its declared type is refused', async ({ browser }) => {
  const user = await documentsOf(browser, USER)
  await user.locator('input[data-test="document-title"]').fill('Getarnt')
  await user.locator('input[type="file"][data-test="document-file"]').setInputFiles({
    name: 'harmlos.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
  })
  await user.getByRole('button', { name: 'Hochladen' }).click()
  await expect(user.getByText('Dieser Dateityp wird nicht angenommen')).toBeVisible()
  await expect(row(user, 'Getarnt')).toHaveCount(0)
})

test('a user sets and removes their picture', async ({ page }) => {
  await loginAs(page, USER, '/profile')
  const avatar = page.locator('[data-test="avatar"] img')
  await expect(avatar).toHaveCount(0)
  await page.locator('input[type="file"][data-test="avatar-input"]').setInputFiles({
    name: 'ich.png',
    mimeType: 'image/png',
    buffer: PNG
  })
  await expect(page.getByText('Bild gespeichert')).toBeVisible()
  // Fetched with the token, shown from memory: never the API's own URL.
  await expect(avatar).toHaveAttribute('src', /^blob:/)
  await expect.poll(() => avatar.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1)

  await page.getByRole('button', { name: 'Entfernen' }).click()
  await expect(page.getByText('Bild entfernt')).toBeVisible()
  await expect(avatar).toHaveCount(0)
})
