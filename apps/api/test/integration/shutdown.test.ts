import { Agent, createServer, request } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { io } from 'socket.io-client'
import { describe, expect, it } from 'vitest'
import { SOCKET_PATH } from '../../src/client.js'
import { SHUTDOWN_GRACE_MS, closeServer } from '../../src/shutdown.js'
import { createTestApp } from '../support/app.js'
import { PUBLIC_ORIGIN } from '../support/saml-idp.js'

// ADR 0006: shutdown finishes well before Podman's SIGKILL, whatever
// connections are open.

const listening = async () => {
  const { app } = await createTestApp()
  const server = await app.listen(0)
  return { app, server, port: (server.address() as AddressInfo).port }
}

// A keep-alive connection left idle after one request, as Nginx keeps them.
const idleKeepAlive = async (port: number) => {
  const agent = new Agent({ keepAlive: true })
  await new Promise<void>((resolve, reject) => {
    request({ port, path: '/api/ping', agent }, (res) => {
      res.resume()
      res.on('end', resolve)
    })
      .on('error', reject)
      .end()
  })
  return agent
}

// A request whose headers never finish: in flight until cut off.
const stuckRequest = (port: number) =>
  new Promise<ReturnType<typeof connect>>((resolve) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write('GET /api/ping HTTP/1.1\r\nHost: localhost\r\n')
      resolve(socket)
    })
    socket.on('error', () => {})
  })

const timed = async (work: () => Promise<unknown>) => {
  const started = Date.now()
  await work()
  return Date.now() - started
}

describe('shutdown', () => {
  it('closes WebSockets and idle keep-alive connections at once, as a transport close', async () => {
    const { app, port } = await listening()
    const socket = io(`http://127.0.0.1:${port}`, { path: SOCKET_PATH, transports: ['websocket'], reconnection: false, extraHeaders: { origin: PUBLIC_ORIGIN } })
    await new Promise<void>((resolve) => socket.once('connect', resolve))
    const disconnected = new Promise<string>((resolve) => socket.once('disconnect', resolve))
    const agent = await idleKeepAlive(port)

    expect(await timed(() => app.teardown())).toBeLessThan(1000)
    // Not 'io server disconnect', after which a client does not reconnect.
    expect(await disconnected).toBe('transport close')
    agent.destroy()
  })

  it('cuts off a request still in flight after the grace period', async () => {
    const { app, port } = await listening()
    const socket = await stuckRequest(port)
    const closed = new Promise((resolve) => socket.once('close', resolve))

    const elapsed = await timed(() => app.teardown())
    expect(elapsed).toBeGreaterThanOrEqual(SHUTDOWN_GRACE_MS - 50)
    expect(elapsed).toBeLessThan(SHUTDOWN_GRACE_MS + 1000)
    await closed
  }, 15_000)

  it('closes the internal listener, cutting off requests in flight after the grace period', async () => {
    // /stuck is never answered: a request the server has received and is
    // still handling. Waiting for it is deterministic; a connection whose
    // bytes the server has not read yet counts as idle, and Node 26 may read
    // them only after close() has run.
    const server = createServer((req, res) => {
      if (req.url !== '/stuck') res.end('ok')
    }).listen(0)
    await new Promise((resolve) => server.once('listening', resolve))
    const port = (server.address() as AddressInfo).port
    const agent = await idleKeepAlive(port)
    const received = new Promise((resolve) => server.once('request', resolve))
    const stuck = connect(port, '127.0.0.1', () => stuck.write('GET /stuck HTTP/1.1\r\nHost: localhost\r\n\r\n'))
    stuck.on('error', () => {})
    await received

    const elapsed = await timed(() => closeServer(server, { graceMs: 200 }))
    expect(elapsed).toBeGreaterThanOrEqual(150)
    expect(elapsed).toBeLessThan(1000)
    expect(server.listening).toBe(false)
    agent.destroy()
  })
})
