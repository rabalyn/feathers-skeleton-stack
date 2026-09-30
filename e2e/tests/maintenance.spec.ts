import { expect, test, type Browser, type Page } from '@playwright/test'
import { ADMIN, USER, loginAs, nav, type Account } from './support.js'

// Maintenance mode (ADR 0025): an admin switches it on, a user's open page
// goes to the maintenance page, the user cannot log in, the admin keeps
// working; switched off, the maintenance page reloads the application at the
// login page. A browser that cannot reach the API waits on the same page.

// The maintenance page polls every 30 seconds.
const POLL = 40_000

const session = async (browser: Browser, who: Account) => {
  const page = await (await browser.newContext()).newPage()
  const { accessToken } = await loginAs(page, who)
  return { page, accessToken }
}

// From the admin's page: only the browser resolves the e2e host names.
const setMaintenance = (admin: Page, accessToken: string, value: boolean) =>
  admin.evaluate(
    async ({ accessToken, value }) =>
      (
        await fetch('/api/settings/maintenanceMode', {
          method: 'PATCH',
          headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ value })
        })
      ).status,
    { accessToken, value }
  )

const switchMaintenance = async (admin: Page, label: 'Einschalten' | 'Ausschalten') => {
  await nav(admin).getByRole('link', { name: 'Einstellungen' }).click()
  await admin.getByRole('button', { name: label }).click()
  await admin.getByRole('dialog').getByRole('button', { name: label }).click()
  await expect(admin.getByText('Einstellung gespeichert')).toBeVisible()
}

test('an admin switches maintenance on and off; a user waits on the maintenance page', async ({ browser }) => {
  test.setTimeout(120_000)
  const admin = await session(browser, ADMIN)
  const user = await session(browser, USER)
  try {
    await switchMaintenance(admin.page, 'Einschalten')
    await expect(admin.page.getByRole('status').filter({ hasText: 'Der Wartungsmodus ist aktiv' })).toBeVisible()

    // The user's session ended, and the open page followed.
    await expect(user.page).toHaveURL(/\/maintenance$/)
    await expect(user.page.getByText('Die Anwendung wird gerade gewartet')).toBeVisible()
    await user.page.goto('/documents')
    await expect(user.page).toHaveURL(/\/maintenance$/)

    // The login stays reachable, but the ACS sends the user back.
    await user.page.getByRole('link', { name: 'Anmeldung für Administratoren' }).click()
    await expect(user.page).toHaveURL(/\/login$/)
    await expect(user.page.getByText('nur Administratoren können sich anmelden')).toBeVisible()
    // The IdP still knows the user from before and answers at once.
    const acs = user.page.waitForResponse((response) => response.url().endsWith('/api/auth/saml/acs'))
    await user.page.getByRole('button', { name: 'Anmelden' }).click()
    expect((await acs).status()).toBe(303)
    await expect(user.page).toHaveURL(/\/maintenance$/)

    // The admin still works.
    await nav(admin.page).getByRole('link', { name: 'Benutzer' }).click()
    await expect(admin.page.getByRole('row').filter({ hasText: 'us01user' })).toBeVisible()

    await switchMaintenance(admin.page, 'Ausschalten')
    await expect(admin.page.getByRole('status').filter({ hasText: 'Der Wartungsmodus ist aktiv' })).toHaveCount(0)
    await expect(user.page).toHaveURL(/\/login$/, { timeout: POLL })
    await expect(user.page.getByText('nur Administratoren können sich anmelden')).toHaveCount(0)
  } finally {
    // Whatever failed, the rest of the run needs the mode off.
    await setMaintenance(admin.page, admin.accessToken, false).catch(() => undefined)
  }
})

test('a browser that cannot reach the API waits on the maintenance page until it is back', async ({ page }) => {
  test.setTimeout(120_000)
  // As if the API were stopped: nothing under /api answers.
  await page.route('**/api/**', (route) => route.abort('connectionrefused'))
  await page.goto('/profile')
  await expect(page).toHaveURL(/\/maintenance$/)
  await expect(page.getByText('Zuletzt geprüft um')).toBeVisible()

  await page.unroute('**/api/**')
  await expect(page).toHaveURL(/\/login$/, { timeout: POLL })
  await expect(page.getByRole('button', { name: 'Anmelden' })).toBeVisible()
})
