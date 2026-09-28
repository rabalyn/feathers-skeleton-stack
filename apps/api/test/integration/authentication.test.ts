import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Application } from '../../src/app.js'
import { createTestApp } from '../support/app.js'
import { PUBLIC_ORIGIN, type TestIdp } from '../support/saml-idp.js'
import { db } from '../support/worker-database.js'

// ADR 0008 (login, just-in-time provisioning) and ADR 0010 (sessions), over
// real HTTP against the app: ACS, refresh cookie, per-request session checks,
// logout.

let app: Application
let idp: TestIdp
let base: string

beforeAll(async () => {
  ;({ app, idp } = await createTestApp())
  const server = await app.listen(0)
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await app.teardown()
})

const loginRequestId = async () => {
  const { inflateRawSync } = await import('node:zlib')
  const location = await fetch(`${base}/api/auth/saml/login?returnTo=/start`, { redirect: 'manual' }).then(
    (r) => r.headers.get('location') ?? ''
  )
  const request = inflateRawSync(
    Buffer.from(new URL(location).searchParams.get('SAMLRequest') ?? '', 'base64')
  ).toString()
  return /ID="([^"]+)"/.exec(request)?.[1] ?? ''
}

// A complete login: returns the ACS response and the refresh cookie.
const login = async (attributes?: Record<string, string>) => {
  const inResponseTo = await loginRequestId()
  const SAMLResponse = await idp.response({ inResponseTo, ...(attributes ? { attributes } : {}) })
  const response = await fetch(`${base}/api/auth/saml/acs`, {
    method: 'POST',
    body: new URLSearchParams({ SAMLResponse }),
    redirect: 'manual'
  })
  const setCookie = response.headers.get('set-cookie') ?? ''
  const cookie = setCookie.split(';')[0] ?? ''
  return { response, setCookie, cookie }
}

const refresh = (cookie: string, origin: string | null = PUBLIC_ORIGIN) =>
  fetch(`${base}/api/authentication`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, ...(origin ? { origin } : {}) },
    body: JSON.stringify({ strategy: 'refresh' })
  })

const accessToken = async (cookie: string) => {
  const response = await refresh(cookie)
  expect(response.status).toBe(201)
  return ((await response.json()) as { accessToken: string; user: { id: string } })
}

const getUser = (token: string, id: string) =>
  fetch(`${base}/api/users/${id}`, { headers: { authorization: `Bearer ${token}` } })

describe('login at the ACS', () => {
  it('redirects to the return path and sets a strict refresh cookie', async () => {
    const { response, setCookie } = await login()
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/start')
    expect(setCookie).toMatch(/^refresh_token=[A-Za-z0-9_-]{43};/)
    for (const flag of ['Path=/api/authentication', 'HttpOnly', 'Secure', 'SameSite=Strict']) {
      expect(setCookie).toContain(flag)
    }
  })

  it('provisions the user just in time, keyed by TU-ID, and refreshes directory fields', async () => {
    await login({ cn: 'jit00001', givenName: 'Jan', sn: 'First', mail: 'jan@example.org' })
    await login({ cn: 'jit00001', givenName: 'Jan', sn: 'Second', mail: 'jan.second@example.org' })
    const rows = await db()('users').where({ tu_id: 'jit00001' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ surname: 'Second', email: 'jan.second@example.org', role: 'user' })
  })

  it('stores the session without the token itself', async () => {
    const { cookie } = await login({ cn: 'store001', givenName: 'S', sn: 'T', mail: 'store@example.org' })
    const token = cookie.split('=')[1] ?? ''
    const sessions = await db()('auth_sessions')
    expect(JSON.stringify(sessions)).not.toContain(token)
  })

  it('answers a bad response generically', async () => {
    const SAMLResponse = await idp.response({ inResponseTo: '_nope' })
    const response = await fetch(`${base}/api/auth/saml/acs`, {
      method: 'POST',
      body: new URLSearchParams({ SAMLResponse }),
      redirect: 'manual'
    })
    expect(response.status).toBe(401)
    expect(await response.text()).toBe('Authentication failed')
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('refuses a disabled account', async () => {
    await login({ cn: 'dis00001', givenName: 'D', sn: 'Isabled', mail: 'dis@example.org' })
    await db()('users').where({ tu_id: 'dis00001' }).update({ enabled: false })
    const { response, setCookie } = await login({ cn: 'dis00001', givenName: 'D', sn: 'Isabled', mail: 'dis@example.org' })
    expect(response.status).toBe(403)
    expect(setCookie).toBe('')
  })
})

describe('refresh', () => {
  it('exchanges the cookie for an access token the API accepts', async () => {
    const { cookie } = await login()
    const { accessToken: token, user } = await accessToken(cookie)
    expect((await getUser(token, user.id)).status).toBe(200)
  })

  it('requires the application origin', async () => {
    const { cookie } = await login()
    expect((await refresh(cookie, null)).status).toBe(403)
    expect((await refresh(cookie, 'https://evil.test')).status).toBe(403)
  })

  it('rejects a missing or unknown cookie', async () => {
    expect((await refresh('')).status).toBe(401)
    expect((await refresh('refresh_token=forged')).status).toBe(401)
  })

  it('rejects a session past its idle or absolute expiry', async () => {
    const idle = await login()
    await db()('auth_sessions').update({ idle_expires_at: db().raw("now() - interval '1 second'") })
    expect((await refresh(idle.cookie)).status).toBe(401)

    const absolute = await login()
    await db()('auth_sessions')
      .whereRaw('idle_expires_at > now()')
      .update({ family_expires_at: db().raw("now() - interval '1 second'"), idle_expires_at: db().raw("now() - interval '2 seconds'") })
    expect((await refresh(absolute.cookie)).status).toBe(401)
  })
})

const cookieOf = (response: Response) => (response.headers.get('set-cookie') ?? '').split(';')[0] ?? ''

const sessionOf = async (userTuId: string) => {
  const [session] = await db()('auth_sessions')
    .join('users', 'users.id', 'auth_sessions.user_id')
    .where('users.tu_id', userTuId)
    .select('auth_sessions.*')
  return session
}

describe('refresh rotation (ADR 0010)', () => {
  it('rotates the cookie on every refresh and keeps the token out of the body', async () => {
    const { cookie } = await login({ cn: 'rot00001', givenName: 'R', sn: 'Ot', mail: 'rot1@example.org' })
    const first = await refresh(cookie)
    expect(first.status).toBe(201)
    const rotated = cookieOf(first)
    expect(rotated).toMatch(/^refresh_token=[A-Za-z0-9_-]{43}$/)
    expect(rotated).not.toBe(cookie)
    const setCookie = first.headers.get('set-cookie') ?? ''
    for (const flag of ['Path=/api/authentication', 'HttpOnly', 'Secure', 'SameSite=Strict']) {
      expect(setCookie).toContain(flag)
    }
    const body = await first.text()
    expect(body).not.toContain(rotated.split('=')[1])
    expect(body).not.toContain('refreshToken')

    const second = await refresh(rotated)
    expect(second.status).toBe(201)
    expect(cookieOf(second)).not.toBe(rotated)
  })

  it('sets the cookie lifetime to what remains of the family', async () => {
    const { setCookie } = await login()
    const maxAge = Number(/Max-Age=(\d+)/.exec(setCookie)?.[1])
    expect(maxAge).toBeGreaterThan(7 * 24 * 3600 - 60)
    expect(maxAge).toBeLessThanOrEqual(7 * 24 * 3600)
  })

  it('keeps the session id, so access tokens of the same login stay valid', async () => {
    const { cookie } = await login({ cn: 'rot00002', givenName: 'R', sn: 'Ot', mail: 'rot2@example.org' })
    const first = await refresh(cookie)
    const { accessToken: oldToken, user } = (await first.json()) as { accessToken: string; user: { id: string } }
    await refresh(cookieOf(first))
    expect((await getUser(oldToken, user.id)).status).toBe(200)
  })

  it('inside the grace window, a rotated-away token yields the same current token', async () => {
    const { cookie } = await login({ cn: 'rot00003', givenName: 'R', sn: 'Ot', mail: 'rot3@example.org' })
    const first = await refresh(cookie)
    // The response was "lost"; the browser retries with the old cookie.
    const retry = await refresh(cookie)
    expect(retry.status).toBe(201)
    expect(cookieOf(retry)).toBe(cookieOf(first))
    // The family is intact and the current token keeps working.
    expect((await refresh(cookieOf(first))).status).toBe(201)
  })

  it('inside the grace window, an older token follows the chain to the current one', async () => {
    const { cookie } = await login({ cn: 'rot00004', givenName: 'R', sn: 'Ot', mail: 'rot4@example.org' })
    const first = await refresh(cookie)
    const second = await refresh(cookieOf(first))
    const retry = await refresh(cookie)
    expect(retry.status).toBe(201)
    expect(cookieOf(retry)).toBe(cookieOf(second))
  })

  it('concurrent refreshes with one cookie converge on one token', async () => {
    const { cookie } = await login({ cn: 'rot00005', givenName: 'R', sn: 'Ot', mail: 'rot5@example.org' })
    const responses = await Promise.all(Array.from({ length: 5 }, () => refresh(cookie)))
    expect(responses.map((r) => r.status)).toEqual([201, 201, 201, 201, 201])
    expect(new Set(responses.map(cookieOf)).size).toBe(1)
    const session = await sessionOf('rot00005')
    expect(session.revoked_at).toBeNull()
    const current = await db()('auth_refresh_tokens').where({ session_id: session.id }).whereNull('rotated_at')
    expect(current).toHaveLength(1)
  })

  it('reuse outside the grace window revokes the whole family and is audited', async () => {
    const { cookie } = await login({ cn: 'rot00006', givenName: 'R', sn: 'Ot', mail: 'rot6@example.org' })
    const first = await refresh(cookie)
    const { accessToken: token, user } = (await first.json()) as { accessToken: string; user: { id: string } }
    const session = await sessionOf('rot00006')
    await db()('auth_refresh_tokens')
      .where({ session_id: session.id })
      .whereNotNull('rotated_at')
      .update({ rotated_at: db().raw("now() - interval '11 seconds'") })

    // The thief (or the victim) presents the rotated-away token ...
    expect((await refresh(cookie)).status).toBe(401)
    // ... and every credential of the family is dead: the current refresh
    // token and the access token issued with it.
    expect((await refresh(cookieOf(first))).status).toBe(401)
    expect((await getUser(token, user.id)).status).toBe(401)

    expect((await sessionOf('rot00006')).revoked_at).not.toBeNull()
    const [event] = await db()('audit_events').where({ action: 'session.reuse-detected', resource_id: session.id })
    expect(event).toMatchObject({ actor_id: user.id, resource_type: 'authSessions' })
  })

  it('the grace window is a runtime setting', async () => {
    await db()('settings').where({ key: 'refreshGraceSeconds' }).update({ value: JSON.stringify(60) })
    try {
      const { cookie } = await login({ cn: 'rot00007', givenName: 'R', sn: 'Ot', mail: 'rot7@example.org' })
      await refresh(cookie)
      const session = await sessionOf('rot00007')
      await db()('auth_refresh_tokens')
        .where({ session_id: session.id })
        .whereNotNull('rotated_at')
        .update({ rotated_at: db().raw("now() - interval '30 seconds'") })
      expect((await refresh(cookie)).status).toBe(201)
    } finally {
      await db()('settings').where({ key: 'refreshGraceSeconds' }).update({ value: JSON.stringify(10) })
    }
  })

  it('stores only hashes of refresh tokens', async () => {
    const { cookie } = await login({ cn: 'rot00008', givenName: 'R', sn: 'Ot', mail: 'rot8@example.org' })
    const rotated = cookieOf(await refresh(cookie))
    const dump = JSON.stringify(await db()('auth_refresh_tokens')) + JSON.stringify(await db()('auth_sessions'))
    for (const value of [cookie, rotated].map((c) => c.split('=')[1] ?? '')) {
      expect(dump).not.toContain(value)
      expect(dump).not.toContain(Buffer.from(value).toString('hex'))
    }
  })
})

describe('session lifetimes are runtime settings (ADR 0025)', () => {
  it('a login takes its idle and absolute expiry from the settings', async () => {
    await db()('settings').where({ key: 'sessionIdleSeconds' }).update({ value: JSON.stringify(600) })
    await db()('settings').where({ key: 'sessionAbsoluteSeconds' }).update({ value: JSON.stringify(3600) })
    try {
      const { setCookie } = await login({ cn: 'life0001', givenName: 'L', sn: 'Ife', mail: 'life@example.org' })
      const session = await sessionOf('life0001')
      const seconds = (at: Date) => (new Date(at).getTime() - new Date(session.issued_at).getTime()) / 1000
      expect(seconds(session.idle_expires_at)).toBeCloseTo(600, -1)
      expect(seconds(session.family_expires_at)).toBeCloseTo(3600, -1)
      expect(Number(/Max-Age=(\d+)/.exec(setCookie)?.[1])).toBeLessThanOrEqual(3600)
    } finally {
      await db()('settings').where({ key: 'sessionIdleSeconds' }).update({ value: JSON.stringify(8 * 3600) })
      await db()('settings').where({ key: 'sessionAbsoluteSeconds' }).update({ value: JSON.stringify(7 * 24 * 3600) })
    }
  })

  it('a refresh extends the idle expiry, never past the absolute one', async () => {
    const { cookie } = await login({ cn: 'life0002', givenName: 'L', sn: 'Ife', mail: 'life2@example.org' })
    const before = await sessionOf('life0002')
    await db()('auth_sessions')
      .where({ id: before.id })
      .update({ family_expires_at: db().raw("now() + interval '1 hour'"), idle_expires_at: db().raw("now() + interval '1 minute'") })
    expect((await refresh(cookie)).status).toBe(201)
    const after = await sessionOf('life0002')
    expect(new Date(after.idle_expires_at).getTime()).toBe(new Date(after.family_expires_at).getTime())
  })
})

describe('every request re-checks the session (ADR 0010)', () => {
  it('rejects a request without a token', async () => {
    const { cookie } = await login()
    const { user } = await accessToken(cookie)
    expect((await fetch(`${base}/api/users/${user.id}`)).status).toBe(401)
  })

  it('ends access immediately when the account is disabled', async () => {
    const { cookie } = await login({ cn: 'dis00002', givenName: 'D', sn: 'Two', mail: 'd2@example.org' })
    const { accessToken: token, user } = await accessToken(cookie)
    expect((await getUser(token, user.id)).status).toBe(200)
    await db()('users').where({ id: user.id }).update({ enabled: false })
    expect((await getUser(token, user.id)).status).toBe(401)
  })

  it('ends access immediately when the role changes', async () => {
    const { cookie } = await login({ cn: 'role0001', givenName: 'R', sn: 'Ole', mail: 'role@example.org' })
    const { accessToken: token, user } = await accessToken(cookie)
    await db()('users').where({ id: user.id }).update({ role: 'operator' })
    expect((await getUser(token, user.id)).status).toBe(401)
    // A fresh token carries the new role and works.
    const renewed = await accessToken(cookie)
    expect((await getUser(renewed.accessToken, user.id)).status).toBe(200)
  })

  it('rejects a token signed with another secret', async () => {
    const { cookie } = await login()
    const { accessToken: token, user } = await accessToken(cookie)
    const [header, payload] = token.split('.')
    expect((await getUser(`${header}.${payload}.forged`, user.id)).status).toBe(401)
  })
})

describe('logout', () => {
  it('revokes the session at once, clears the cookie and hands over a signed IdP logout', async () => {
    const { cookie } = await login()
    const { accessToken: token, user } = await accessToken(cookie)

    const response = await fetch(`${base}/api/authentication`, {
      method: 'DELETE',
      headers: { cookie, origin: PUBLIC_ORIGIN }
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toMatch(/^refresh_token=; Path=\/api\/authentication; Max-Age=0/)
    const body = (await response.json()) as { idpLogoutUrl: string }
    const logoutUrl = new URL(body.idpLogoutUrl)
    expect(logoutUrl.searchParams.get('SAMLRequest')).toBeTruthy()
    expect(logoutUrl.searchParams.get('Signature')).toBeTruthy()

    // The access token is still inside its 15 minutes, and useless.
    expect((await getUser(token, user.id)).status).toBe(401)
    expect((await refresh(cookie)).status).toBe(401)
  })

  it('requires the application origin', async () => {
    const { cookie } = await login()
    const response = await fetch(`${base}/api/authentication`, { method: 'DELETE', headers: { cookie } })
    expect(response.status).toBe(403)
    expect((await refresh(cookie)).status).toBe(201)
  })
})
