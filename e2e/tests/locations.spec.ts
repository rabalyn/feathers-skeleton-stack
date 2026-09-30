import { expect, test, type Page } from '@playwright/test'
import { ADMIN, IDP_ORIGIN, OPERATOR, USER, loginAs, nav, type Account } from './support.js'

// Locations (ADR 0031): the Buildings page reads the seeded NetBox through
// the api, and NetBox itself lets people in through the IdP, with the rights
// their IdP groups give: ad01admn is in netbox-admins, op01oper in
// netbox-editors and netbox-readers, us02othr in none.

const NETBOX = 'https://netbox.localhost:8443'
const OTHER: Account = { tuId: 'us02othr', password: 'other-test-password' }

test('the Buildings page finds a building by its address, a page at a time', async ({ page }) => {
  await loginAs(page, USER)
  await nav(page).getByRole('link', { name: 'Gebäude' }).click()
  await expect(page).toHaveURL(/\/sites$/)
  const table = page.locator('[data-test="sites-table"]')
  const rows = table.locator('tbody tr')
  // Every building, paginated on the server like the activity log.
  await expect(rows).toHaveCount(25)
  const first = await rows.first().innerText()
  // Quasar's last button in the table's footer: the next page.
  await table.locator('.q-table__bottom button').last().click()
  await expect(rows.first()).not.toHaveText(first)

  await table.getByLabel('Kennung, Name oder Adresse').fill('Karolinenplatz 5')
  const karo5 = rows.filter({ hasText: 'S1|01' })
  await expect(karo5).toContainText('Universitätszentrum')
  await expect(karo5).toContainText('Karolinenplatz 5, 64289 Darmstadt')
  await expect(karo5.getByRole('link', { name: 'In NetBox öffnen' })).toHaveAttribute(
    'href',
    new RegExp(`^${NETBOX}/dcim/sites/\\d+/$`)
  )

  await table.getByLabel('Kennung, Name oder Adresse').fill('kein Gebäude heißt so')
  await expect(table.getByText('Keine Treffer')).toBeVisible()
})

const netboxLogin = async (page: Page, who: Account) => {
  await page.goto(`${NETBOX}/dcim/sites/`)
  await expect(page).toHaveURL(new RegExp(`^${NETBOX}/login/`))
  await page.getByRole('button', { name: /TU-ID/ }).click()
  await expect(page).toHaveURL(IDP_ORIGIN)
  await page.locator('#username').fill(who.tuId)
  await page.locator('#password').fill(who.password)
  await page.locator('#kc-login').click()
  await expect(page).toHaveURL(`${NETBOX}/dcim/sites/`)
}

test('NetBox: an editor logs in through the IdP and reads the seeded sites', async ({ page }) => {
  await netboxLogin(page, OPERATOR)
  await page.goto(`${NETBOX}/dcim/sites/?q=Karolinenplatz`)
  await expect(page.getByRole('link', { name: 'S1|01 Universitätszentrum, karo 5, Audimax' })).toBeVisible()
  // A reader and editor, not an administrator. Through the page, which
  // maps netbox.localhost to Nginx; page.request would not.
  expect((await page.goto(`${NETBOX}/users/users/`))?.status()).toBe(403)
})

test('NetBox: a member of netbox-admins is a superuser', async ({ page }) => {
  await netboxLogin(page, ADMIN)
  expect((await page.goto(`${NETBOX}/users/users/`))?.status()).toBe(200)
})

test('NetBox: somebody in none of its groups gets in, but sees no sites', async ({ page }) => {
  await netboxLogin(page, OTHER)
  await page.goto(`${NETBOX}/dcim/sites/?q=Karolinenplatz`)
  await expect(page.getByRole('link', { name: /^S1\|01 / })).toHaveCount(0)
})
