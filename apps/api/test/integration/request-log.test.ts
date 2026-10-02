import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import socketio from '@feathersjs/socketio-client'
import { pino } from 'pino'
import { io } from 'socket.io-client'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Application } from '../../src/app.js'
import { createClient, SOCKET_PATH } from '../../src/client.js'
import { createLogger, loggerOptions } from '../../src/logger.js'
import type { User } from '../../src/services/users/users.schema.js'
import { createTestApp } from '../support/app.js'
import { PUBLIC_ORIGIN } from '../support/saml-idp.js'
import {  } from '../support/roles.js'
import { grantRoles } from '../support/roles.js'

// ADR 0021: one line per request with its route template, status and
// duration; one request id shared by every line of the request, by its audit
// events and by the response; the user as surrogate key only.

let app: Application
let base: string
let admin: User
let lines: Record<string, unknown>[]

const REQUEST_ID = /^[0-9a-f]{32}$/

beforeAll(async () => {
  ;({ app } = await createTestApp())
  // The application's own log format, captured.
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      for (const line of chunk.toString().split('\n').filter(Boolean)) lines.push(JSON.parse(line) as Record<string, unknown>)
      done()
    }
  })
  app.set('logger', pino(loggerOptions('api', 'info'), sink))
  const server = await app.listen(0)
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const created = await app
    .service('users')
    .create({ tuId: 'rl01rlog', givenName: 'R', surname: 'L', email: null, authSource: 'saml' })
  admin = await grantRoles(app, created.id, ['admin'])
})

beforeEach(() => {
  lines = []
})

afterAll(async () => {
  await app.teardown()
})

const tokenFor = async (user: User) => {
  const { session } = await app.get('sessions').issue(user.id)
  return app.service('authentication').createAccessToken({ sid: session.id }, { subject: user.id })
}

const requestLines = () => lines.filter((line) => line.msg === 'request')

describe('HTTP request log', () => {
  it('logs the route template, status, duration and user, under the id the response names', async () => {
    const token = await tokenFor(admin)
    const response = await fetch(`${base}/api/users/${admin.id}`, { headers: { authorization: `Bearer ${token}` } })
    expect(response.status).toBe(200)
    const requestId = response.headers.get('x-request-id')
    expect(requestId).toMatch(REQUEST_ID)

    const [line] = requestLines()
    expect(line).toMatchObject({
      level: 'info',
      service: 'api',
      route: '/api/users/:id',
      method: 'GET',
      status: 200,
      request_id: requestId,
      user_ref: admin.id
    })
    expect(line?.duration_ms).toEqual(expect.any(Number))
    expect(line?.timestamp).toEqual(expect.any(String))
    // Never the TU-ID, never the path with the id in it.
    expect(JSON.stringify(lines)).not.toContain('rl01rlog')
    expect(line?.route).not.toContain(admin.id)
  })

  it('names routes outside the services, and nothing else by its path', async () => {
    await fetch(`${base}/api/ping`)
    await fetch(`${base}/api/no/such/thing/${admin.id}`)
    await fetch(`${base}/elsewhere`)
    expect(requestLines().map((line) => [line.route, line.status])).toEqual([
      ['/api/ping', 200],
      ['unmatched', 404],
      ['unmatched', 404]
    ])
  })

  it('keeps a well-formed request id from the proxy and replaces anything else', async () => {
    // Loopback plays Nginx in the tests (support/app.ts).
    const fromProxy = 'a'.repeat(32)
    const kept = await fetch(`${base}/api/ping`, { headers: { 'x-request-id': fromProxy } })
    expect(kept.headers.get('x-request-id')).toBe(fromProxy)
    const replaced = await fetch(`${base}/api/ping`, { headers: { 'x-request-id': 'forged-id; drop' } })
    expect(replaced.headers.get('x-request-id')).toMatch(REQUEST_ID)
    expect(requestLines().map((line) => line.request_id)).toEqual([fromProxy, replaced.headers.get('x-request-id')])
  })

  it('an audit event carries the id of the request it happened in', async () => {
    const token = await tokenFor(admin)
    const target = await app
      .service('users')
      .create({ tuId: 'rl02rlog', givenName: 'R', surname: 'L', email: null, authSource: 'saml' })
    const response = await fetch(`${base}/api/users/${target.id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false })
    })
    expect(response.status).toBe(200)
    const [event] = await app.get('knex')('auditEvents').where({ action: 'users.patch', resourceId: target.id })
    expect(event).toMatchObject({ requestId: response.headers.get('x-request-id') })
  })
})

describe('WebSocket call log', () => {
  it('logs each call with a request id of its own', async () => {
    const socket = io(base, { path: SOCKET_PATH, transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: { origin: PUBLIC_ORIGIN } })
    try {
      const client = createClient(socketio.default(socket as never))
      await client.authenticate({ strategy: 'jwt', accessToken: await tokenFor(admin) })
      await client.service('users').get(admin.id)
      await vi.waitFor(() => expect(requestLines().some((line) => line.route === '/api/users/:id')).toBe(true))
      const line = requestLines().find((entry) => entry.route === '/api/users/:id')
      expect(line).toMatchObject({ method: 'get', status: 200, user_ref: admin.id, request_id: expect.stringMatching(REQUEST_ID) })
    } finally {
      socket.disconnect()
    }
  })
})

describe('log files', () => {
  it('writes the same JSON lines to rotated files named <base>.<n>.log', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'logs-'))
    const logger = await createLogger('worker', 'info', join(dir, 'worker'))
    logger.error({ detail: 1 }, 'written to the file')
    logger.flush()
    await vi.waitFor(async () => expect((await readdir(dir)).sort()).toEqual(['worker.1.log']))
    await vi.waitFor(async () => {
      const content = await readFile(join(dir, 'worker.1.log'), 'utf8')
      expect(JSON.parse(content.trim())).toMatchObject({ level: 'error', service: 'worker', msg: 'written to the file' })
    })
  })
})
