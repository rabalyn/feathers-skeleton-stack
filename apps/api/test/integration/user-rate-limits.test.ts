import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Application } from '../../src/app.js'
import { RATE_LIMITS, type RateLimitBucket } from '../../src/rate-limit.js'
import type { ApiToken } from '../../src/services/api-tokens/api-tokens.schema.js'
import type { User } from '../../src/services/users/users.schema.js'
import { SETTINGS } from '../../src/settings/registry.js'
import { createValkey } from '../../src/valkey.js'
import { createTestApp, loadValkeyConfig } from '../support/app.js'
import { makeUser } from '../support/roles.js'
import { db } from '../support/worker-database.js'

// ADR 0010, 0034: an endpoint that is costly or can be turned against
// someone else has a bucket of its own, keyed by the authenticated user (an
// API token counts as its owner, ADR 0029), with its limit a runtime setting
// (ADR 0025). Over the limit is a 429; a Valkey outage refuses the request.
//
// The limit is counted before validation, so these requests need not be
// valid: under the limit each is answered by the endpoint (400, 415, ...),
// past it by the limiter, and nothing is stored, queued or looked up.

const listen = async (app: Application) => {
  const server = await app.listen(0)
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
}

const login = async (app: Application, user: User): Promise<string> => {
  const { session } = await app.get('sessions').issue(user.id)
  return app.service('authentication').createAccessToken({ sid: session.id }, { subject: user.id })
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
})

type UserBucket = Extract<RateLimitBucket, 'uploads' | 'dataExports' | 'mailCampaigns' | 'updateChecks' | 'directorySearch' | 'siteLookup'>

// One request per bucket, as the endpoint's path and request.
const requests: Record<UserBucket, [string, RequestInit]> = {
  uploads: ['/files', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'not a file' }],
  dataExports: ['/data-exports', json({})],
  mailCampaigns: ['/mail-campaigns', json({})],
  updateChecks: ['/update-checks', json({ now: true })],
  directorySearch: ['/directory', {}],
  siteLookup: ['/sites?unknown=1', {}]
}
const BUCKETS = Object.keys(requests) as UserBucket[]

const send = (base: string, bearer: string, bucket: UserBucket) => {
  const [path, init] = requests[bucket]
  return fetch(`${base}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${bearer}` } })
}

const setLimit = (bucket: UserBucket, value: number) =>
  db()('settings').where({ key: RATE_LIMITS[bucket] }).update({ value: JSON.stringify(value) })

const resetLimits = async () => {
  for (const bucket of BUCKETS) await setLimit(bucket, SETTINGS[RATE_LIMITS[bucket]].default)
}

describe('with Valkey available', () => {
  let app: Application
  let base: string
  let rateLimitPrefix: string
  let admin: User
  let otherAdmin: User
  let adminLogin: string
  let otherLogin: string

  beforeAll(async () => {
    ;({ app, rateLimitPrefix } = await createTestApp({ system: { updateCheck: 'on' } }))
    base = await listen(app)
    admin = await makeUser(app, 'rl01admn', 'admin')
    otherAdmin = await makeUser(app, 'rl02admn', 'admin')
    adminLogin = await login(app, admin)
    otherLogin = await login(app, otherAdmin)
  })
  afterEach(resetLimits)
  afterAll(async () => {
    await app.teardown()
  })

  it.each(BUCKETS)('%s: refuses the request past the limit, per user', async (bucket) => {
    await setLimit(bucket, 2)
    const first = await send(base, adminLogin, bucket)
    const second = await send(base, adminLogin, bucket)
    expect([first.status, second.status]).not.toContain(429)
    const third = await send(base, adminLogin, bucket)
    expect(third.status).toBe(429)
    const { retryAfterSeconds } = ((await third.json()) as { data: { retryAfterSeconds: number } }).data
    expect(retryAfterSeconds).toBeGreaterThanOrEqual(1)
    expect(retryAfterSeconds).toBeLessThanOrEqual(60)
    // Someone else is unaffected.
    expect((await send(base, otherLogin, bucket)).status).not.toBe(429)
  })

  it('counts under the user, in a one-minute window', async () => {
    const user = await makeUser(app, 'rl03user')
    await send(base, await login(app, user), 'siteLookup')
    const ttl = await app.get('valkey').pttl(`${rateLimitPrefix}:siteLookup:${user.id}`)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(60_000)
  })

  it('stores nothing past the limit', async () => {
    const user = await makeUser(app, 'rl04user')
    const bearer = await login(app, user)
    await setLimit('uploads', 1)
    const png = Buffer.concat([
      Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex'),
      Buffer.alloc(64, 1)
    ])
    const upload = () =>
      fetch(`${base}/files`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'image/png', 'x-file-name': 'pixel.png' },
        body: new Uint8Array(png)
      })
    expect((await upload()).status).toBe(201)
    expect((await upload()).status).toBe(429)
    expect(await db()('files').where({ owner_id: user.id }).count({ n: '*' })).toEqual([{ n: '1' }])
  })

  it('counts an API token as its owner (ADR 0029)', async () => {
    const owner = await makeUser(app, 'rl05admn', 'admin')
    const ownerLogin = await login(app, owner)
    const created = await fetch(`${base}/api-tokens`, {
      ...json({ name: 'script', permissions: ['sites.read'] }),
      headers: { authorization: `Bearer ${ownerLogin}`, 'content-type': 'application/json' }
    })
    expect(created.status).toBe(201)
    const { token } = (await created.json()) as ApiToken
    await setLimit('siteLookup', 2)
    expect((await send(base, ownerLogin, 'siteLookup')).status).not.toBe(429)
    expect((await send(base, token!, 'siteLookup')).status).not.toBe(429)
    expect((await send(base, token!, 'siteLookup')).status).toBe(429)
    expect((await send(base, ownerLogin, 'siteLookup')).status).toBe(429)
  })

  it('a raised limit applies at once (runtime setting)', async () => {
    const user = await makeUser(app, 'rl06user')
    const bearer = await login(app, user)
    await setLimit('siteLookup', 1)
    await send(base, bearer, 'siteLookup')
    expect((await send(base, bearer, 'siteLookup')).status).toBe(429)
    await setLimit('siteLookup', 120)
    expect((await send(base, bearer, 'siteLookup')).status).toBe(400)
  })

  it('a call that is refused before the limit uses none of it', async () => {
    const member = await makeUser(app, 'rl07user')
    const bearer = await login(app, member)
    await setLimit('mailCampaigns', 1)
    // Members may not send campaigns: 403, not counted.
    expect((await send(base, bearer, 'mailCampaigns')).status).toBe(403)
    expect(await app.get('valkey').exists(`${rateLimitPrefix}:mailCampaigns:${member.id}`)).toBe(0)
  })
})

describe('with Valkey unreachable (fail closed)', () => {
  let app: Application
  let base: string
  let adminLogin: string

  beforeAll(async () => {
    const valkey = createValkey({ ...(await loadValkeyConfig()), valkeyPort: 1 })
    valkey.on('error', () => undefined)
    ;({ app } = await createTestApp({ valkey, system: { updateCheck: 'on' } }))
    base = await listen(app)
    adminLogin = await login(app, await makeUser(app, 'rl11admn', 'admin'))
  })
  afterAll(async () => {
    await app.teardown()
  })

  it.each(BUCKETS)('%s is refused with 503', async (bucket) => {
    expect((await send(base, adminLogin, bucket)).status).toBe(503)
  })

  it('internal calls are not counted, so they are served', async () => {
    await expect(app.service('sites').find({ query: { q: 'Karolinenplatz 5' } })).resolves.toHaveProperty('data')
  })
})
