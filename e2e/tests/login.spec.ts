import { expect, test, type Page } from '@playwright/test'

// The first end-to-end slice (ADR 0015): SAML2 login through the local IdP,
// the in-memory access token obtained by refresh, an API call with it, and
// logout taking effect immediately.

const USER = { tuId: 'us01user', password: 'user-test-password' }

interface Refreshed {
  accessToken: string
  user: { id: string; tuId: string; givenName: string; surname: string; role: string }
}
interface LoggedOut {
  loggedOut: boolean
  idpLogoutUrl: string
}

const loginAs = async (page: Page, who = USER) => {
  await page.goto('/')
  await page.getByRole('link', { name: 'Anmelden' }).click()
  await expect(page).toHaveURL(/^https:\/\/idp\.localhost:8443\//)
  await page.locator('#username').fill(who.tuId)
  await page.locator('#password').fill(who.password)
  await page.locator('#kc-login').click()
  await expect(page).toHaveURL(/^https:\/\/app\.localhost:8443\/$/)
}

// What the SPA does on every start (ADR 0014): exchange the cookie for an
// access token held in memory only.
const refresh = (page: Page) =>
  page.evaluate(async () => {
    const response = await fetch('/api/authentication', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ strategy: 'refresh' })
    })
    return { status: response.status, body: response.status === 201 ? await response.json() : null }
  }) as Promise<{ status: number; body: Refreshed | null }>

const getUser = (page: Page, token: string, id: string) =>
  page.evaluate(
    async ([t, userId]) => (await fetch(`/api/users/${userId}`, { headers: { authorization: `Bearer ${t}` } })).status,
    [token, id] as const
  )

test('SAML login, API access and immediate logout', async ({ page, context }) => {
  await loginAs(page)

  const [cookie] = (await context.cookies()).filter((c) => c.name === 'refresh_token')
  expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/api/authentication' })

  const { status, body: refreshed } = await refresh(page)
  expect(status).toBe(201)
  const body = refreshed as Refreshed
  expect(body.user).toMatchObject({ tuId: 'us01user', givenName: 'Uma', surname: 'User', role: 'user' })
  const token: string = body.accessToken
  expect(await getUser(page, token, body.user.id)).toBe(200)

  // Nothing about the session is readable from the page.
  expect(await page.evaluate(() => document.cookie)).not.toContain('refresh_token')

  const logout = await page.evaluate(async () => {
    const response = await fetch('/api/authentication', { method: 'DELETE' })
    return { status: response.status, body: (await response.json()) as LoggedOut }
  })
  expect(logout.status).toBe(200)
  expect(logout.body.idpLogoutUrl).toMatch(/^https:\/\/idp\.localhost:8443\/.*SAMLRequest=.*Signature=/)

  // The access token is still inside its 15 minutes, and already useless.
  expect(await getUser(page, token, body.user.id)).toBe(401)
  expect((await refresh(page)).status).toBe(401)

  // SP-initiated single logout: the IdP ends its session and sends the
  // browser back through our logout endpoint to the start page.
  await page.goto(logout.body.idpLogoutUrl)
  await expect(page).toHaveURL(/^https:\/\/app\.localhost:8443\/$/)

  // The IdP session is gone too: logging in asks for credentials again.
  await page.getByRole('link', { name: 'Anmelden' }).click()
  await expect(page.locator('#username')).toBeVisible()
})

test('a wrong password never reaches the application', async ({ page, context }) => {
  await page.goto('/api/auth/saml/login')
  await page.locator('#username').fill(USER.tuId)
  await page.locator('#password').fill('wrong-password')
  await page.locator('#kc-login').click()
  await expect(page).toHaveURL(/^https:\/\/idp\.localhost:8443\//)
  expect((await context.cookies()).some((c) => c.name === 'refresh_token')).toBe(false)
})
