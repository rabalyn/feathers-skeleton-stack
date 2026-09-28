import { expect, test, type Download } from '@playwright/test'
import { fromBufferPromise } from 'yauzl'
import { ADMIN, OPERATOR, USER, loginAs, nav } from './support.js'

// GDPR through the real UI (ADR 0013, 0015): a user's self-export is built by
// the worker, arrives live and downloads as a ZIP of the expected shape; an
// admin erases a person on the data requests page, and the activity log
// records it.

const read = async (download: Download) => {
  const chunks: Buffer[] = []
  for await (const chunk of (await download.createReadStream()) as AsyncIterable<Buffer>) chunks.push(chunk)
  return Buffer.concat(chunks)
}

const entries = async (zipped: Buffer) => {
  const zip = await fromBufferPromise(zipped)
  const found = new Map<string, Buffer>()
  for await (const entry of zip.eachEntry()) {
    const chunks: Buffer[] = []
    for await (const chunk of await zip.openReadStreamPromise(entry)) chunks.push(chunk as Buffer)
    found.set(entry.fileName, Buffer.concat(chunks))
  }
  return found
}

test('a user exports their own data and downloads it once it is ready', async ({ page }) => {
  await loginAs(page, USER, '/profile')
  const myData = page.locator('[data-test="my-data"]')
  await myData.getByRole('button', { name: 'Meine Daten exportieren' }).click()

  // The worker builds it; the outcome arrives over the socket, unreloaded.
  const ready = myData.locator('[data-state="ready"]').first()
  await expect(ready).toBeVisible({ timeout: 30_000 })
  const downloaded = page.waitForEvent('download')
  await ready.getByRole('button', { name: 'Herunterladen' }).click()
  const download = await downloaded
  expect(download.suggestedFilename()).toMatch(/^data-export-\d{4}-\d{2}-\d{2}\.zip$/)

  const files = await entries(await read(download))
  const json = JSON.parse(files.get('export.json')!.toString('utf8')) as Record<string, unknown>
  expect(json).toMatchObject({
    format: 'data-export/1',
    account: { tuId: 'us01user', givenName: 'Uma', surname: 'User' },
    sessions: expect.arrayContaining([expect.objectContaining({ revokedAt: null })]),
    auditEvents: expect.arrayContaining([expect.objectContaining({ action: 'login' })]),
    documents: expect.any(Array),
    files: expect.any(Array)
  })
  for (const file of json.files as { path: string }[]) expect(files.has(file.path)).toBe(true)

  // The request and the download are in the user's own activity.
  await page.reload()
  const activity = page.locator('[data-test="my-activity"]')
  await expect(activity).toContainText('Datenexport angefordert')
  await expect(activity).toContainText('Datenexport heruntergeladen')
})

test('an admin erases a person after typing their TU-ID, and the activity log shows it', async ({ page, browser }) => {
  await loginAs(page, ADMIN)
  await nav(page).getByRole('link', { name: 'Datenanfragen' }).click()

  // The admin's own account cannot be erased; the page says so up front.
  await page.locator('input[data-test="gdpr-tu-id"]').fill('ad01admn')
  await page.getByRole('button', { name: 'Suchen' }).click()
  await expect(page.locator('[data-test="gdpr-erase-refused"]')).toBeVisible()

  await page.locator('input[data-test="gdpr-tu-id"]').fill('us03gone')
  await page.getByRole('button', { name: 'Suchen' }).click()
  const person = page.locator('[data-test="gdpr-person"]')
  await expect(person).toContainText('Greta')

  await person.getByRole('button', { name: 'Diese Person löschen' }).click()
  const dialog = page.getByRole('dialog')
  const confirm = dialog.getByRole('button', { name: 'Diese Person löschen' })
  await dialog.locator('input[data-test="gdpr-confirm-input"]').fill('us03gon')
  await expect(confirm).toBeDisabled()
  await dialog.locator('input[data-test="gdpr-confirm-input"]').fill('us03gone')
  await confirm.click()
  await expect(page.getByText('Die Person wurde gelöscht')).toBeVisible()

  await page.locator('input[data-test="gdpr-tu-id"]').fill('us03gone')
  await page.getByRole('button', { name: 'Suchen' }).click()
  await expect(page.locator('[data-test="gdpr-not-found"]')).toBeVisible()

  // An operator reads the activity log, and the erasure is in it.
  const operator = await (await browser.newContext()).newPage()
  await loginAs(operator, OPERATOR)
  await nav(operator).getByRole('link', { name: 'Aktivitätsprotokoll' }).click()
  await expect(operator.getByRole('row').filter({ hasText: 'Konto gelöscht' })).toContainText('ad01admn')
})
