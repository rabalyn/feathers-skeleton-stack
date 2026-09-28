import { expect, test, type Browser, type Page } from '@playwright/test'
import { ADMIN, USER, loginAs, nav } from './support.js'

// Mail end to end (ADR 0027): the export-ready notification and a mailing
// sent from the Mailings page leave through worker-e2e and arrive in
// Mailpit, read here through Nginx at mail.localhost like a person would;
// and the template editor refuses wording that cannot work.

const MAILPIT = 'https://mail.localhost:8443'
const UMA = 'uma.user@example.org'

interface Message {
  ID: string
  Subject: string
  Created: string
}

// A page on Mailpit's origin, whose API it asks.
const mailpit = async (browser: Browser) => {
  const page = await (await browser.newContext()).newPage()
  await page.goto(`${MAILPIT}/api/v1/info`)
  return page
}

// The text of the first mail to `address` with `subject` created since
// `since`, once it has arrived.
const arrived = async (inbox: Page, address: string, subject: string, since: Date): Promise<string> => {
  let found: Message | undefined
  await expect
    .poll(
      async () => {
        const query = `to:"${address}" subject:"${subject}"`
        const { messages } = await inbox.evaluate(
          async (q) => (await fetch(`/api/v1/search?query=${encodeURIComponent(q)}`)).json() as Promise<{ messages: Message[] }>,
          query
        )
        found = messages.find((message) => new Date(message.Created).getTime() >= since.getTime() - 2000)
        return found !== undefined
      },
      { timeout: 60_000, intervals: [1000] }
    )
    .toBe(true)
  return inbox.evaluate(async (id) => ((await (await fetch(`/api/v1/message/${id}`)).json()) as { Text: string }).Text, found!.ID)
}

const setLanguage = async (page: Page, current: string, next: string) => {
  await page.getByRole('button', { name: current === 'Deutsch' ? 'Sprache' : 'Language' }).click()
  await page.getByRole('menuitem', { name: next }).or(page.getByText(next, { exact: true })).first().click()
}

test('a user asks for their data in English, and the ready notification arrives in English', async ({ page, browser }) => {
  const inbox = await mailpit(browser)
  const since = new Date()
  await loginAs(page, USER, '/profile')
  // The language on screen becomes the account's: mail follows it.
  await setLanguage(page, 'Deutsch', 'English')
  const myData = page.locator('[data-test="my-data"]')
  await myData.getByRole('button', { name: 'Export my data' }).click()
  await expect(myData.locator('[data-state="ready"]').first()).toBeVisible({ timeout: 30_000 })

  const text = await arrived(inbox, UMA, 'Your data export is ready', since)
  expect(text).toContain('Hello Uma User')
  expect(text).toContain('https://e2e.localhost:8443/profile')

  await setLanguage(page, 'English', 'Deutsch')
  await expect(page.getByRole('button', { name: 'Meine Daten exportieren' })).toBeVisible()
})

test('an admin previews a mailing for an actual recipient, sends it, and it arrives', async ({ page, browser }) => {
  const inbox = await mailpit(browser)
  // Something to remind Uma of.
  const uma = await (await browser.newContext()).newPage()
  await loginAs(uma, USER)
  await nav(uma).getByRole('link', { name: 'Dokumente' }).click()
  await uma.locator('input[data-test="document-title"]').fill('Mailing-Probe')
  await uma.locator('input[type="file"][data-test="document-file"]').setInputFiles({
    name: 'probe.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n')
  })
  await uma.getByRole('button', { name: 'Hochladen' }).click()
  await expect(uma.getByText('Dokument hochgeladen')).toBeVisible()

  const since = new Date()
  await loginAs(page, ADMIN)
  await nav(page).getByRole('link', { name: 'Mailings' }).click()
  await page.locator('[data-test="mailing-kind"]').click()
  await page.getByRole('option', { name: 'Erinnerung an alte Dokumente' }).click()
  await page.locator('input[data-test="mailing-param-olderThanDays"]').fill('0')
  await page.getByRole('button', { name: 'Empfänger und Vorschau' }).click()

  const previewed = page.locator('[data-test="mailing-previewed"]')
  await expect(previewed.locator('[data-test="mailing-recipients"]')).toContainText('Empfänger:innen')
  await expect(previewed).toContainText('Vorschau für')
  await expect(previewed.locator('[data-test="mail-preview-subject"]')).toHaveText('Ihre Dokumente wurden länger nicht bearbeitet')

  await previewed.getByRole('button', { name: 'Senden' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Senden' }).click()
  await expect(page.getByText('Mailing wird versendet')).toBeVisible()

  const text = await arrived(inbox, UMA, 'Ihre Dokumente wurden länger nicht bearbeitet', since)
  expect(text).toContain('Hallo Uma User')
  expect(text).toContain('- Mailing-Probe, zuletzt geändert am')
  expect(text).toContain('https://e2e.localhost:8443/documents')

  // The campaign's progress and the delivery log say so too.
  await expect(async () => {
    await page.getByRole('button', { name: 'Aktualisieren' }).click()
    await expect(page.locator('[data-test="mailing-campaigns"]')).toContainText('Im Versand')
    await expect(page.locator('[data-test="mailing-deliveries"]')).toContainText('Uma User')
  }).toPass({ timeout: 30_000 })
})

test('an admin edits a template: wrong wording is refused with its line, a saved version can be rolled back', async ({ page }) => {
  await loginAs(page, ADMIN)
  await nav(page).getByRole('link', { name: 'E-Mail-Vorlagen' }).click()
  await page.locator('[data-test="mail-kind-gdpr.export-ready"]').click()
  const subject = page.locator('input[data-test="mail-subject"]')
  const body = page.locator('textarea[data-test="mail-body"]')
  await expect(subject).toHaveValue('Ihr Datenexport ist bereit')

  await body.fill('Hallo\n\n{{ recipient.vorname }}')
  await page.getByRole('button', { name: 'Als neue Version speichern' }).click()
  await expect(page.locator('[data-test="mail-problems"]')).toContainText('Text, Zeile 3')

  await subject.fill('Ihr Export liegt bereit')
  await body.fill('Hallo {{ recipient.givenName }}, **fertig**.')
  await page.getByRole('button', { name: 'Vorschau' }).click()
  await expect(page.locator('[data-test="mail-preview-subject"]')).toHaveText('Ihr Export liegt bereit')
  await page.getByRole('button', { name: 'Als neue Version speichern' }).click()
  await expect(page.getByText('Vorlage gespeichert')).toBeVisible()

  // Back to the version before.
  const history = page.locator('[data-test="mail-history"]')
  await history.locator('.q-item').filter({ hasText: 'Ihr Datenexport ist bereit' }).first().getByRole('button', { name: 'Aktivieren' }).click()
  await expect(page.getByText('Version aktiviert')).toBeVisible()
  await expect(subject).toHaveValue('Ihr Datenexport ist bereit')
})
