import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Application } from '../../src/app.js'
import { createInternalServer } from '../../src/internal.js'
import { createValkey } from '../../src/valkey.js'
import { createTestApp, loadValkeyConfig } from '../support/app.js'

// ADR 0022: readiness reports each dependency the API needs, answers 503
// while one is down, and the same checks reach Prometheus as dependency_up.

describe('with Valkey unreachable', () => {
  let app: Application

  beforeAll(async () => {
    const valkey = createValkey({ ...(await loadValkeyConfig()), valkeyPort: 1 })
    valkey.on('error', () => undefined)
    ;({ app } = await createTestApp({ valkey }))
  })
  afterAll(async () => {
    await app.teardown()
  })

  it('names the dependency that is down', async () => {
    expect(await app.get('readiness')()).toEqual({ postgres: true, valkey: false, s3: true })
  })

  it('answers 503 on /health/ready while liveness stays 200', async () => {
    const server = createInternalServer({ metrics: app.get('metrics'), ready: app.get('readiness') }).listen(0)
    try {
      await new Promise((resolve) => server.once('listening', resolve))
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      const ready = await fetch(`${base}/health/ready`)
      expect(ready.status).toBe(503)
      expect(await ready.json()).toEqual({ status: 'down', checks: { postgres: 'ok', valkey: 'down', s3: 'ok' } })
      expect((await fetch(`${base}/health/live`)).status).toBe(200)
    } finally {
      server.close()
    }
  })

  it('reports it as dependency_up 0', async () => {
    const text = await app.get('metrics').metrics()
    expect(text).toMatch(/dependency_up\{dependency="valkey",service="api"\} 0/)
    expect(text).toMatch(/dependency_up\{dependency="postgres",service="api"\} 1/)
  })
})

describe('with the object store unreachable', () => {
  let app: Application

  beforeAll(async () => {
    ;({ app } = await createTestApp({ s3: { s3Endpoint: 'https://127.0.0.1:1' } }))
  })
  afterAll(async () => {
    await app.teardown()
  })

  it('names it, and reports it as dependency_up 0', async () => {
    // Valkey commands fail fast rather than queue until the fresh
    // connection is up (ADR 0010).
    await vi.waitFor(async () => expect(await app.get('readiness')()).toEqual({ postgres: true, valkey: true, s3: false }))
    expect(await app.get('metrics').metrics()).toMatch(/dependency_up\{dependency="s3",service="api"\} 0/)
  })
})

describe('without a readiness check', () => {
  it('does not serve /health/ready, as for the worker', async () => {
    const { app } = await createTestApp()
    const server = createInternalServer({ metrics: app.get('metrics') }).listen(0)
    try {
      await new Promise((resolve) => server.once('listening', resolve))
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      expect((await fetch(`${base}/health/ready`)).status).toBe(404)
    } finally {
      server.close()
      await app.teardown()
    }
  })
})
