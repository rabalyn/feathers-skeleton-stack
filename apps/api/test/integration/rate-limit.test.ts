import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Application } from '../../src/app.js'
import { createValkey } from '../../src/valkey.js'
import { createTestApp, loadValkeyConfig } from '../support/app.js'
import { PUBLIC_ORIGIN } from '../support/saml-idp.js'
import { db } from '../support/worker-database.js'

// ADR 0010: fail-closed rate limits in Valkey on the SAML login start, the
// ACS and refresh, keyed by the client address Nginx reports (ADR 0016).

const listen = async (app: Application) => {
  const server = await app.listen(0)
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
}

const setLimit = (key: string, value: number) =>
  db()('settings').where({ key }).update({ value: JSON.stringify(value) })

const requests = {
  samlLogin: (base: string, ip?: string) =>
    fetch(`${base}/auth/saml/login`, { redirect: 'manual', headers: ip ? { 'x-forwarded-for': ip } : {} }),
  samlAcs: (base: string, ip?: string) =>
    fetch(`${base}/auth/saml/acs`, {
      method: 'POST',
      body: new URLSearchParams({ SAMLResponse: 'bm90IGEgcmVzcG9uc2U=' }),
      redirect: 'manual',
      headers: ip ? { 'x-forwarded-for': ip } : {}
    }),
  refresh: (base: string, ip?: string) =>
    fetch(`${base}/authentication`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: PUBLIC_ORIGIN, ...(ip ? { 'x-forwarded-for': ip } : {}) },
      body: JSON.stringify({ strategy: 'refresh' })
    })
}

const settingOf = {
  samlLogin: 'rateLimitSamlLoginPerMinute',
  samlAcs: 'rateLimitSamlAcsPerMinute',
  refresh: 'rateLimitRefreshPerMinute'
} as const

describe('with Valkey available', () => {
  let app: Application
  let base: string
  let rateLimitPrefix: string

  beforeAll(async () => {
    ;({ app, rateLimitPrefix } = await createTestApp())
    base = await listen(app)
  })
  afterAll(async () => {
    await app.teardown()
  })
  afterEach(async () => {
    for (const key of Object.values(settingOf)) await setLimit(key, key === 'rateLimitRefreshPerMinute' ? 600 : 60)
  })

  it.each(Object.keys(requests) as (keyof typeof requests)[])(
    '%s: refuses the attempt past the limit, per client address',
    async (bucket) => {
      await setLimit(settingOf[bucket], 2)
      const ip = `198.51.100.${Object.keys(requests).indexOf(bucket) + 10}`
      const first = await requests[bucket](base, ip)
      const second = await requests[bucket](base, ip)
      expect([first.status, second.status]).not.toContain(429)
      const third = await requests[bucket](base, ip)
      expect(third.status).toBe(429)
      if (bucket !== 'refresh') {
        expect(Number(third.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
        expect(Number(third.headers.get('retry-after'))).toBeLessThanOrEqual(60)
      }
      // Someone else behind another address is unaffected.
      expect((await requests[bucket](base, '198.51.100.99')).status).not.toBe(429)
    }
  )

  it('a raised limit applies at once (runtime setting)', async () => {
    await setLimit('rateLimitSamlLoginPerMinute', 1)
    const ip = '198.51.100.20'
    await requests.samlLogin(base, ip)
    expect((await requests.samlLogin(base, ip)).status).toBe(429)
    await setLimit('rateLimitSamlLoginPerMinute', 60)
    expect((await requests.samlLogin(base, ip)).status).toBe(302)
  })

  it('counters expire with their one-minute window', async () => {
    await requests.samlLogin(base, '198.51.100.21')
    const ttl = await app.get('valkey').pttl(`${rateLimitPrefix}:samlLogin:198.51.100.21`)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(60_000)
  })
})

describe('X-Forwarded-For from anyone but the proxy', () => {
  let app: Application
  let base: string

  beforeAll(async () => {
    ;({ app } = await createTestApp({ trustedProxyHost: 'nginx.invalid' }))
    base = await listen(app)
  })
  afterAll(async () => {
    await app.teardown()
    await setLimit('rateLimitSamlLoginPerMinute', 60)
  })

  it('is ignored: a client cannot escape its limit by claiming other addresses', async () => {
    await setLimit('rateLimitSamlLoginPerMinute', 2)
    expect((await requests.samlLogin(base, '203.0.113.1')).status).toBe(302)
    expect((await requests.samlLogin(base, '203.0.113.2')).status).toBe(302)
    expect((await requests.samlLogin(base, '203.0.113.3')).status).toBe(429)
  })
})

describe('with Valkey unreachable (fail closed)', () => {
  let app: Application
  let base: string

  beforeAll(async () => {
    const valkey = createValkey({ ...(await loadValkeyConfig()), valkeyPort: 1 })
    valkey.on('error', () => undefined)
    ;({ app } = await createTestApp({ valkey }))
    base = await listen(app)
  })
  afterAll(async () => {
    await app.teardown()
  })

  it.each(Object.keys(requests) as (keyof typeof requests)[])('%s is refused with 503', async (bucket) => {
    const response = await requests[bucket](base, '198.51.100.30')
    expect(response.status).toBe(503)
  })

  it('does not write an authentication request when refused', async () => {
    const before = await db()('saml_requests').count({ n: '*' })
    await requests.samlLogin(base)
    expect(await db()('saml_requests').count({ n: '*' })).toEqual(before)
  })
})
