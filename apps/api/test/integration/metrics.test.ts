import { mkdtemp, writeFile } from 'node:fs/promises'
import { request } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Application } from '../../src/app.js'
import { createInternalServer } from '../../src/internal.js'
import { createTestApp } from '../support/app.js'
import { keyPair } from '../support/saml-idp.js'

// ADR 0022: the api's baseline series, labelled by route template, and the
// internal listener serving them over TLS.

let app: Application
let base: string

beforeAll(async () => {
  ;({ app } = await createTestApp())
  const server = await app.listen(0)
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await app.teardown()
})

const scrape = () => app.get('metrics').metrics()

describe('api metrics', () => {
  it('counts requests and their duration per route template and status', async () => {
    await fetch(`${base}/api/ping`)
    await fetch(`${base}/api/users/01a0d950-4ccc-71d2-bc85-40a1a963e526`)
    const text = await scrape()
    expect(text).toMatch(/http_requests_total\{route="\/api\/ping",method="GET",status_code="200",service="api"\} \d+/)
    expect(text).toMatch(/http_requests_total\{route="\/api\/users\/:id",method="GET",status_code="401",service="api"\} \d+/)
    expect(text).toMatch(/http_request_duration_seconds_bucket\{le="0.005",service="api",route="\/api\/ping",method="GET"\}/)
    // Never an id in a label.
    expect(text).not.toContain('01a0d950')
  })

  it('reports the Knex pool, open WebSocket connections and the process', async () => {
    const text = await scrape()
    for (const state of ['used', 'idle', 'waiting']) {
      expect(text).toMatch(new RegExp(`knex_pool_connections\\{state="${state}",service="api"\\} \\d+`))
    }
    expect(text).toMatch(/websocket_connections\{service="api"\} 0/)
    expect(text).toContain('process_cpu_seconds_total')
    expect(text).toMatch(/dependency_up\{dependency="postgres",service="api"\} 1/)
    expect(text).toMatch(/dependency_up\{dependency="valkey",service="api"\} 1/)
  })
})

describe('internal listener', () => {
  it('serves liveness, readiness and metrics over TLS', async () => {
    const { certificate, privateKey } = await keyPair('localhost')
    const dir = await mkdtemp(join(tmpdir(), 'internal-'))
    await writeFile(join(dir, 'tls.crt'), certificate)
    await writeFile(join(dir, 'tls.key'), privateKey)
    const server = createInternalServer({
      metrics: app.get('metrics'),
      ready: app.get('readiness'),
      tls: { certFile: join(dir, 'tls.crt'), keyFile: join(dir, 'tls.key') }
    }).listen(0)
    try {
      await new Promise((resolve) => server.once('listening', resolve))
      const port = (server.address() as AddressInfo).port
      const get = (path: string) =>
        new Promise<{ status: number; body: string }>((resolve, reject) => {
          request({ host: 'localhost', port, path, ca: certificate }, (res) => {
            let body = ''
            res.on('data', (chunk: Buffer) => (body += chunk.toString()))
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
          })
            .on('error', reject)
            .end()
        })
      expect(await get('/health/live')).toEqual({ status: 200, body: '{"status":"ok"}' })
      const ready = await get('/health/ready')
      expect(ready.status).toBe(200)
      expect(JSON.parse(ready.body)).toEqual({ status: 'ok', checks: { postgres: 'ok', valkey: 'ok' } })
      const metrics = await get('/metrics')
      expect(metrics.status).toBe(200)
      expect(metrics.body).toContain('http_requests_total')
      expect((await get('/elsewhere')).status).toBe(404)
    } finally {
      server.close()
    }
  })
})
