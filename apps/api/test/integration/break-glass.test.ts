import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Application } from '../../src/app.js'
import { BreakGlassError, createBreakGlass, rotateBreakGlass } from '../../src/auth/break-glass.js'
import { verifyPassword } from '../../src/auth/password.js'
import { createTestApp } from '../support/app.js'
import { PUBLIC_ORIGIN } from '../support/saml-idp.js'
import { db } from '../support/worker-database.js'

// ADR 0008: the break-glass account, created and rotated by the bootstrap
// command, and its password login. ADR 0010: its account-and-IP rate limit.

const EMAIL = 'breakglass@example.test'

let app: Application
let base: string
let password: string

beforeAll(async () => {
  ;({ app } = await createTestApp())
  const server = await app.listen(0)
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
  ;({ password } = await createBreakGlass(app.get('knex'), EMAIL))
})

afterAll(async () => {
  await app.teardown()
})

const login = (body: Record<string, unknown>, { ip = '192.0.2.1', origin = PUBLIC_ORIGIN }: { ip?: string; origin?: string | null } = {}) =>
  fetch(`${base}/authentication`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': ip,
      ...(origin ? { origin } : {})
    },
    body: JSON.stringify({ strategy: 'password', ...body })
  })

const auditOf = (action: string) =>
  db()('audit_events').where({ action }).orderBy('occurred_at', 'desc').first<{ actor_id: string | null; detail: Record<string, unknown> } | undefined>()

describe('the bootstrap command', () => {
  it('creates one local admin with no TU-ID, and an audit event', async () => {
    const user = await db()('users').where({ auth_source: 'local' }).first()
    expect(user).toMatchObject({ email: EMAIL, role: 'admin', enabled: true, tu_id: null })
    expect(await auditOf('breakglass.create')).toMatchObject({ actor_id: null })
  })

  it('stores only an argon2id hash of the password', async () => {
    const { password_hash: hash } = await db()('local_credentials').first('password_hash')
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=4\$/)
    expect(hash).not.toContain(password)
    expect(await verifyPassword(password, hash as string)).toBe(true)
  })

  it('refuses to create a second account', async () => {
    await expect(createBreakGlass(app.get('knex'), 'second@example.test')).rejects.toThrow(BreakGlassError)
    expect(await db()('users').where({ auth_source: 'local' }).count().first()).toMatchObject({ count: '1' })
  })

  it('refuses an address that is not one', async () => {
    await expect(createBreakGlass(app.get('knex'), 'not an address')).rejects.toThrow(BreakGlassError)
  })
})

describe('the password login', () => {
  it('opens a session: refresh cookie, access token, admin rights, audit event', async () => {
    const response = await login({ email: EMAIL.toUpperCase(), password })
    expect(response.status).toBe(201)
    expect(response.headers.get('set-cookie')).toMatch(/^refresh_token=[^;]+; Path=\/api\/authentication;.*HttpOnly/)
    const body = (await response.json()) as { accessToken: string; user: Record<string, unknown> }
    expect(body.user).toMatchObject({ email: EMAIL, role: 'admin', authSource: 'local', tuId: null })
    expect(JSON.stringify(body)).not.toMatch(/argon2|passwordHash|refreshToken/)

    const settings = await fetch(`${base}/settings`, { headers: { authorization: `Bearer ${body.accessToken}` } })
    expect(settings.status).toBe(200)
    expect(await auditOf('login')).toMatchObject({ detail: { method: 'password' } })
  })

  it.each([
    ['a wrong password', { email: EMAIL, password: 'wrong' }, 'wrong password'],
    ['an unknown address', { email: 'nobody@example.test', password: 'any-password' }, 'unknown account']
  ])('refuses %s with the same answer, and records why', async (_case, body, reason) => {
    const response = await login(body, { ip: '192.0.2.10' })
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ message: 'Invalid login' })
    expect(await auditOf('login.refused')).toMatchObject({ detail: { method: 'password', reason } })
  })

  it('refuses a disabled account', async () => {
    await db()('users').where({ auth_source: 'local' }).update({ enabled: false })
    try {
      const response = await login({ email: EMAIL, password }, { ip: '192.0.2.11' })
      expect(response.status).toBe(401)
      expect(await auditOf('login.refused')).toMatchObject({ detail: { reason: 'account disabled' } })
    } finally {
      await db()('users').where({ auth_source: 'local' }).update({ enabled: true })
    }
  })

  it('refuses a request from another origin', async () => {
    expect((await login({ email: EMAIL, password }, { ip: '192.0.2.12', origin: 'https://evil.test' })).status).toBe(403)
    expect((await login({ email: EMAIL, password }, { ip: '192.0.2.12', origin: null })).status).toBe(403)
  })

  it('refuses malformed and oversized input', async () => {
    expect((await login({ email: EMAIL }, { ip: '192.0.2.13' })).status).toBe(401)
    expect((await login({ email: EMAIL, password: 'x'.repeat(257) }, { ip: '192.0.2.13' })).status).toBe(401)
  })

  it('limits attempts per account and client IP, without locking out other addresses', async () => {
    const attempts = []
    for (let i = 0; i < 6; i++) attempts.push((await login({ email: EMAIL, password: 'wrong' }, { ip: '192.0.2.20' })).status)
    expect(attempts).toEqual([401, 401, 401, 401, 401, 429])
    // The right password from the same address is refused too, until the window ends.
    expect((await login({ email: EMAIL, password }, { ip: '192.0.2.20' })).status).toBe(429)
    expect((await login({ email: EMAIL, password }, { ip: '192.0.2.21' })).status).toBe(201)
  })
})

describe('rotation', () => {
  it('replaces the password and ends every session of the account', async () => {
    const response = await login({ email: EMAIL, password }, { ip: '192.0.2.30' })
    const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? ''

    const rotated = await rotateBreakGlass(app.get('knex'))
    expect(rotated.email).toBe(EMAIL)
    expect(rotated.password).not.toBe(password)
    expect(await auditOf('breakglass.rotate')).toMatchObject({ actor_id: null })

    const refresh = await fetch(`${base}/authentication`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: PUBLIC_ORIGIN },
      body: JSON.stringify({ strategy: 'refresh' })
    })
    expect(refresh.status).toBe(401)
    expect((await login({ email: EMAIL, password }, { ip: '192.0.2.31' })).status).toBe(401)
    expect((await login({ email: EMAIL, password: rotated.password }, { ip: '192.0.2.31' })).status).toBe(201)
    password = rotated.password
  })
})
