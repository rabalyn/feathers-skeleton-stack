import { describe, expect, it, vi } from 'vitest'
import {
  REFRESH_LOCK,
  accessTokenExpiry,
  accessTokenSession,
  classifyStatus,
  renewalDelay,
  requestRefresh,
  retryDelay,
  type RefreshDependencies
} from '@/api/refresh'

const token = (payload: object) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`

// A lock manager that runs callbacks one at a time, as the browser does.
const serialLocks = () => {
  let tail = Promise.resolve<unknown>(undefined)
  const names: string[] = []
  return {
    names,
    request: ((name: string, callback: () => Promise<unknown>) => {
      names.push(name)
      const run = tail.then(callback)
      tail = run.catch(() => undefined)
      return run
    }) as unknown as LockManager['request']
  }
}

const deps = (fetch: RefreshDependencies['fetch'], locks = serialLocks()): RefreshDependencies => ({ fetch, locks })

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const USER = { id: 'u1', role: 'user' }

describe('classifyStatus', () => {
  it('treats only 401 and 403 as the end of the session', () => {
    expect(classifyStatus(201)).toBe('ok')
    expect(classifyStatus(401)).toBe('rejected')
    expect(classifyStatus(403)).toBe('rejected')
  })

  it('never logs out on rate limits, outages or server errors (ADR 0010)', () => {
    for (const status of [408, 429, 500, 502, 503, 504]) expect(classifyStatus(status)).toBe('transient')
  })
})

describe('requestRefresh', () => {
  it('posts the refresh strategy with the cookie and returns the new token', async () => {
    const fetch = vi.fn(async () => json(201, { accessToken: 'a.b.c', authentication: { strategy: 'refresh' }, user: USER }))
    const outcome = await requestRefresh(deps(fetch))
    expect(outcome).toMatchObject({ kind: 'ok', response: { accessToken: 'a.b.c', user: USER } })
    expect(fetch).toHaveBeenCalledWith('/api/authentication', expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      body: JSON.stringify({ strategy: 'refresh' })
    }))
  })

  it('reports a rejected session', async () => {
    expect(await requestRefresh(deps(async () => json(401, { name: 'NotAuthenticated' })))).toEqual({ kind: 'rejected' })
  })

  it('reports a 503 as transient', async () => {
    expect(await requestRefresh(deps(async () => json(503, {})))).toEqual({ kind: 'transient' })
  })

  it('reports a network failure and a missing API behind Nginx as unreachable', async () => {
    expect(await requestRefresh(deps(async () => Promise.reject(new TypeError('offline'))))).toEqual({ kind: 'unreachable' })
    expect(await requestRefresh(deps(async () => new Response('<html>', { status: 502 })))).toEqual({ kind: 'unreachable' })
    expect(await requestRefresh(deps(async () => new Response('<html>', { status: 504 })))).toEqual({ kind: 'unreachable' })
  })

  it('reports a refusal for maintenance (ADR 0025)', async () => {
    const refusal = { name: 'Unavailable', code: 503, message: 'Maintenance mode is active', data: { maintenance: true } }
    expect(await requestRefresh(deps(async () => json(503, refusal)))).toEqual({ kind: 'maintenance' })
  })

  it('reports a malformed success as transient rather than trusting it', async () => {
    expect(await requestRefresh(deps(async () => new Response('<html>', { status: 201 })))).toEqual({ kind: 'transient' })
    expect(await requestRefresh(deps(async () => json(201, { user: USER })))).toEqual({ kind: 'transient' })
  })

  it('never has two refreshes in flight across tabs', async () => {
    const locks = serialLocks()
    let active = 0
    let most = 0
    const fetch = vi.fn(async () => {
      most = Math.max(most, ++active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
      return json(201, { accessToken: 'a.b.c', authentication: { strategy: 'refresh' }, user: USER })
    })
    await Promise.all([requestRefresh(deps(fetch, locks)), requestRefresh(deps(fetch, locks)), requestRefresh(deps(fetch, locks))])
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(most).toBe(1)
    expect(new Set(locks.names)).toEqual(new Set([REFRESH_LOCK]))
  })
})

describe('scheduling', () => {
  it('reads the expiry from the token payload', () => {
    expect(accessTokenExpiry(token({ exp: 1_000 }))).toBe(1_000_000)
    expect(accessTokenExpiry(token({}))).toBeNull()
    expect(accessTokenExpiry('garbage')).toBeNull()
  })

  it('reads the session id from the token payload', () => {
    expect(accessTokenSession(token({ sid: 'abc', exp: 1 }))).toBe('abc')
    expect(accessTokenSession(token({ sid: 1 }))).toBeNull()
    expect(accessTokenSession('garbage')).toBeNull()
  })

  it('renews a minute before expiry, never sooner than five seconds', () => {
    expect(renewalDelay(900_000, 0)).toBe(840_000)
    expect(renewalDelay(30_000, 0)).toBe(5_000)
    expect(renewalDelay(null, 0)).toBe(5_000)
  })

  it('backs off exponentially up to a minute', () => {
    expect([0, 1, 2, 3, 10].map(retryDelay)).toEqual([2_000, 4_000, 8_000, 16_000, 60_000])
  })
})
