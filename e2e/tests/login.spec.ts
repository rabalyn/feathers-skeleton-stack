import { expect, test } from '@playwright/test'
import { APP } from '../playwright.config.js'
import { ADMIN, IDP_ORIGIN, OPERATOR, USER, loginAs, nav, expectNav, E2E_ROLES, OPERATOR_ROLE, USER_ROLE } from './support.js'

// SAML2 login through the local IdP into the real frontend (ADR 0014, 0015):
// session restore with an in-memory access token, role-based visibility,
// and logout taking effect immediately.

test('login, session restore, profile and immediate logout', async ({ page, context }) => {
  // CSP violations and uncaught errors only show in the console (ADR 0018).
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' && message.location().url.startsWith(`${APP}/`)) {
      problems.push(message.text())
    }
  })

  // An unauthenticated deep link goes to the login page and comes back.
  const refreshed = await loginAs(page, USER, '/profile')
  await expect(page).toHaveURL(/\/profile$/)
  await expect(page.locator('[data-field="tuId"]')).toHaveText('us01user')
  await expect(page.locator('[data-field="givenName"]')).toHaveText('Uma')
  await expect(page.locator('[data-field="role"]')).toHaveText(USER_ROLE)

  const [cookie] = (await context.cookies()).filter((c) => c.name === 'refresh_token')
  expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/api/authentication' })
  // Nothing about the session is readable or kept by the page.
  expect(await page.evaluate(() => document.cookie)).not.toContain('refresh_token')
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(
    refreshed.accessToken
  )

  // A reload restores the session from the cookie alone.
  await page.reload()
  await expect(page.locator('[data-field="tuId"]')).toHaveText('us01user')

  // A user sees only their profile.
  await expectNav(page, ['Mein Profil', 'Dokumente', 'Gebäude'])
  await page.goto('/users')
  await expect(page).toHaveURL(/\/profile$/)

  // German by default, English on request, and the choice is remembered.
  await page.getByRole('button', { name: 'Sprache' }).click()
  await page.getByRole('menuitem', { name: 'English' }).or(page.getByText('English', { exact: true })).click()
  await expect(page.locator('[data-field="role"]')).toHaveText(E2E_ROLES['e2e-user'].name.en)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible()

  // Logout: the session is revoked at once, then the IdP ends its own and
  // sends the browser back through our logout endpoint.
  await page.getByRole('button', { name: 'Log out' }).click()
  await expect(page).toHaveURL(/\/login/)
  const status = await page.evaluate(
    async ([token, id]) => (await fetch(`/api/users/${id}`, { headers: { authorization: `Bearer ${token}` } })).status,
    [refreshed.accessToken, refreshed.user.id] as const
  )
  expect(status).toBe(401)
  // The one expected error is that deliberate 401.
  expect(problems.filter((text) => !text.includes('401'))).toEqual([])

  // The IdP session is gone too: logging in asks for credentials again.
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page.locator('#username')).toBeVisible()
})

test('an operator reads users but changes nothing, and sees no settings', async ({ page }) => {
  await loginAs(page, OPERATOR)
  await expectNav(page, ['Mein Profil', 'Dokumente', 'Gebäude', 'Benutzer', 'Verzeichnis', 'Sitzungen', 'Aktivitätsprotokoll'])

  await nav(page).getByRole('link', { name: 'Benutzer' }).click()
  const row = page.getByRole('row').filter({ hasText: 'us01user' })
  await expect(row).toBeVisible()
  await expect(row.getByRole('switch')).toBeDisabled()

  // Configuration is the admin's alone (ADR 0011).
  await page.goto('/settings')
  await expect(page).toHaveURL(/\/profile$/)
})

test('an admin adds a role, and the directory finds people', async ({ page }) => {
  await loginAs(page, ADMIN)
  await nav(page).getByRole('link', { name: 'Benutzer' }).click()

  // us02othr has an account (seeded) but never logs in during the run.
  const row = page.getByRole('row').filter({ hasText: 'us02othr' })
  await row.getByRole('combobox', { name: 'Rollen' }).click()
  await page.getByRole('option', { name: OPERATOR_ROLE, exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByText('Gespeichert')).toBeVisible()
  await page.reload()
  await expect(page.getByRole('row').filter({ hasText: 'us02othr' })).toContainText(OPERATOR_ROLE)

  await nav(page).getByRole('link', { name: 'Verzeichnis' }).click()
  await page.getByLabel('Name, TU-ID oder E-Mail').fill('us0')
  await expect(page.getByText('us01user', { exact: false })).toBeVisible()
  await expect(page.getByText('us02othr', { exact: false })).toBeVisible()

  // 120 bulk people: one search stops at the directory's 100, paged on the
  // server (ADR 0008).
  await page.getByLabel('Name, TU-ID oder E-Mail').fill('Bulk')
  await expect(page.getByRole('status')).toContainText('höchstens 100 Treffer')
  await expect(page.getByText('1–25 von 100')).toBeVisible()
  // Which 100 of the 120 the directory returns is its own choice.
  await expect(page.getByRole('row').filter({ hasText: 'Bea Bulk' })).toHaveCount(25)
  await page.getByRole('button', { name: 'Letzte Seite' }).click()
  await expect(page.getByText('76–100 von 100')).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: 'Bea Bulk' })).toHaveCount(25)
})

test('a wrong password never reaches the application', async ({ page, context }) => {
  await page.goto('/login')
  await page.getByRole('button', { name: 'Anmelden' }).click()
  await page.locator('#username').fill(USER.tuId)
  await page.locator('#password').fill('wrong-password')
  await page.locator('#kc-login').click()
  await expect(page).toHaveURL(IDP_ORIGIN)
  expect((await context.cookies()).some((c) => c.name === 'refresh_token')).toBe(false)
})

test('the SPA answers deep links and keeps its assets immutable', async ({ page }) => {
  // Through the browser, which maps the public host names to nginx.
  const index = await page.goto('/settings')
  expect(index?.status()).toBe(200)
  expect(index?.headers()['cache-control']).toBe('no-store')
  const asset = (await index!.text()).match(/\/assets\/[^"]+\.js/)?.[0]
  expect(asset).toBeTruthy()
  const cacheControl = await page.evaluate(async (path) => (await fetch(path)).headers.get('cache-control'), asset!)
  expect(cacheControl).toContain('immutable')
})
