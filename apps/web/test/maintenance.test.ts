import { describe, expect, it, vi } from 'vitest'
import { fetchMaintenanceState, isMaintenanceRefusal } from '@/api/maintenance'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('fetchMaintenanceState', () => {
  it('asks the public state, uncached', async () => {
    const fetch = vi.fn(async () => json(200, { active: true }))
    expect(await fetchMaintenanceState(fetch)).toBe('active')
    expect(fetch).toHaveBeenCalledWith('/api/maintenance', expect.objectContaining({ cache: 'no-store' }))
    expect(await fetchMaintenanceState(async () => json(200, { active: false }))).toBe('inactive')
  })

  it('knows nothing when the API does not answer or cannot say', async () => {
    expect(await fetchMaintenanceState(async () => Promise.reject(new TypeError('offline')))).toBe('unknown')
    expect(await fetchMaintenanceState(async () => new Response('<html>', { status: 502 }))).toBe('unknown')
    expect(await fetchMaintenanceState(async () => json(503, { active: null }))).toBe('unknown')
    expect(await fetchMaintenanceState(async () => new Response('<html>', { status: 200 }))).toBe('unknown')
  })

  it('knows nothing when the answer does not come in time', async () => {
    // A proxy holding the request open: only the abort ends it.
    const hanging = (_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError'))))
    expect(await fetchMaintenanceState(hanging, 10)).toBe('unknown')
  })
})

describe('isMaintenanceRefusal', () => {
  it('recognises only a 503 that names maintenance', () => {
    expect(isMaintenanceRefusal({ code: 503, data: { maintenance: true } })).toBe(true)
    expect(isMaintenanceRefusal({ code: 503, data: {} })).toBe(false)
    expect(isMaintenanceRefusal({ code: 401, data: { maintenance: true } })).toBe(false)
    expect(isMaintenanceRefusal(null)).toBe(false)
  })
})
