import type { AddressInfo } from 'node:net'
import { AuthenticationClient } from '@feathersjs/authentication-client'
import socketio from '@feathersjs/socketio-client'
import { io, type Socket } from 'socket.io-client'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Application } from '../../src/app.js'
import { createClient, SOCKET_PATH, type ClientApplication } from '../../src/client.js'
import type { User } from '../../src/services/users/users.schema.js'
import { hashRefreshToken } from '../../src/auth/sessions.js'
import { createTestApp } from '../support/app.js'
import { db } from '../support/worker-database.js'
import { PUBLIC_ORIGIN } from '../support/saml-idp.js'

// ADR 0012 over real WebSockets through the typed client: which connection
// receives which event, and that a changed role, a disabled account or a
// revoked session closes the sockets it concerns.

let app: Application
let base: string
let admin: User
let operator: User
let member: User
let other: User

const as = (user: User) => ({ provider: 'rest' as const, user, authenticated: true })

beforeAll(async () => {
  ;({ app } = await createTestApp())
  const server = await app.listen(0)
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const users = app.service('users')
  const make = async (tuId: string, role: User['role']) => {
    const created = await users.create({ tuId, givenName: tuId, surname: 'Test', email: null, authSource: 'saml' })
    return role === 'user' ? created : users.patch(created.id, { role })
  }
  admin = await make('ad01admn', 'admin')
  operator = await make('op01oper', 'operator')
  member = await make('us01user', 'user')
  other = await make('us02othr', 'user')
})

afterAll(async () => {
  await app.teardown()
})

interface Connection {
  socket: Socket
  client: ClientApplication
  events: { path: string; event: string; data: unknown }[]
  disconnects: string[]
  sessionId?: string
  accessToken?: string
}

const open: Connection[] = []

// As in the browser (apps/web/src/api/feathers.ts): the library must not
// re-authenticate a reconnected socket by itself; the tests do it.
class ManualAuthenticationClient extends AuthenticationClient {
  override handleSocket(): void {}
}

afterEach(() => {
  for (const connection of open.splice(0)) connection.socket.disconnect()
})

// A socket that records every service event it receives. It sends the
// application's origin, as a browser would.
const connect = async (): Promise<Connection> => {
  const socket = io(base, {
    path: SOCKET_PATH,
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    extraHeaders: { origin: PUBLIC_ORIGIN }
  })
  // CommonJS under NodeNext, as in src/client.ts; its types name the CJS
  // build of socket.io-client, this import the ESM one.
  const client = createClient(socketio.default(socket as never), { Authentication: ManualAuthenticationClient })
  const connection: Connection = { socket, client, events: [], disconnects: [] }
  for (const path of ['users', 'settings', 'documents', 'data-exports'] as const) {
    for (const event of ['created', 'updated', 'patched', 'removed']) {
      client.service(path).on(event, (data: unknown) => connection.events.push({ path, event, data }))
    }
  }
  socket.on('disconnect', (reason) => connection.disconnects.push(reason))
  await new Promise<void>((resolve, reject) => socket.once('connect', resolve).once('connect_error', reject))
  open.push(connection)
  return connection
}

// A fresh session for `user` and an access token for it, as the refresh
// would issue.
const tokenFor = async (user: User) => {
  const { session } = await app.get('sessions').issue(user.id)
  const accessToken = await app
    .service('authentication')
    .createAccessToken({ sid: session.id, role: user.role }, { subject: user.id })
  return { sessionId: session.id, accessToken }
}

const connectAs = async (user: User): Promise<Connection> => {
  const connection = await connect()
  const { sessionId, accessToken } = await tokenFor(user)
  await connection.client.authenticate({ strategy: 'jwt', accessToken })
  return Object.assign(connection, { sessionId, accessToken })
}

// Events go out asynchronously after the call returns. Waits for those that
// must arrive, then long enough for any that must not to have shown up.
const settle = async (check: () => void) => {
  await vi.waitFor(check, { timeout: 2000, interval: 20 })
  await new Promise((resolve) => setTimeout(resolve, 150))
}

const received = (connection: Connection, path: string) => connection.events.filter((e) => e.path === path)

describe('who receives an event', () => {
  it('a user record goes to its owner, admins and operators, and to no other user or anonymous connection', async () => {
    const [asAdmin, asOperator, asOwner, asOther, anonymous] = await Promise.all([
      connectAs(admin),
      connectAs(operator),
      connectAs(member),
      connectAs(other),
      connect()
    ])
    // Changes nothing, so no socket is closed, but still an event.
    await app.service('users').patch(member.id, { enabled: true }, as(admin))

    await settle(() => {
      for (const connection of [asAdmin, asOperator, asOwner]) {
        expect(received(connection, 'users')).toHaveLength(1)
      }
    })
    expect(received(asAdmin, 'users')[0]).toMatchObject({ event: 'patched', data: { id: member.id, tuId: 'us01user' } })
    expect(received(asOther, 'users')).toEqual([])
    expect(anonymous.events).toEqual([])
  })

  it('a document goes to its owner, admins and operators, and to no other user (ADR 0012)', async () => {
    const [asAdmin, asOperator, asOwner, asOther] = await Promise.all([
      connectAs(admin),
      connectAs(operator),
      connectAs(member),
      connectAs(other)
    ])
    // A stored file row is all a document needs here; the bytes are the
    // uploads test's concern.
    const [file] = await db()('files')
      .insert({ owner_id: member.id, filename: 'a.pdf', content_type: 'application/pdf', size_bytes: 1, sha256: '0'.repeat(64), state: 'stored' })
      .returning<{ id: string }[]>('id')
    const document = await app.service('documents').create({ title: 'Live', fileId: file!.id }, as(member))

    await settle(() => {
      for (const connection of [asAdmin, asOperator, asOwner]) {
        expect(received(connection, 'documents')).toHaveLength(1)
      }
    })
    expect(received(asOwner, 'documents')[0]).toMatchObject({ event: 'created', data: { id: document.id, title: 'Live' } })
    expect(received(asOther, 'documents')).toEqual([])
  })

  it("an export goes to the account that asked for it only, not to its subject (ADR 0013)", async () => {
    const [asAdmin, asOperator, asSubject, asOther] = await Promise.all([
      connectAs(admin),
      connectAs(operator),
      connectAs(member),
      connectAs(other)
    ])
    // The row as a request leaves it; the worker's outcome arrives as the
    // relay's internal patch.
    const [row] = await db()('data_exports').insert({ subject_id: member.id, requested_by: admin.id }).returning<{ id: string }[]>('id')
    await app.service('data-exports').patch(row!.id, { state: 'failed', completedAt: new Date().toISOString() })

    await settle(() => expect(received(asAdmin, 'data-exports')).toHaveLength(1))
    expect(received(asAdmin, 'data-exports')[0]).toMatchObject({ event: 'patched', data: { id: row!.id, subjectId: member.id } })
    for (const connection of [asOperator, asSubject, asOther]) expect(received(connection, 'data-exports')).toEqual([])
  })

  it('the payload is the one REST returns, not the internal result', async () => {
    const asAdmin = await connectAs(admin)
    const viaRest = await app.service('users').patch(other.id, { enabled: true }, as(admin))
    await settle(() => expect(received(asAdmin, 'users')).toHaveLength(1))
    expect(received(asAdmin, 'users')[0]?.data).toEqual(JSON.parse(JSON.stringify(viaRest)))
  })

  it('a setting goes to admins only (ADR 0011)', async () => {
    const [asAdmin, asOperator, asMember] = await Promise.all([connectAs(admin), connectAs(operator), connectAs(member)])
    await app.service('settings').patch('refreshGraceSeconds', { value: 20 }, as(admin))
    await app.service('settings').patch('refreshGraceSeconds', { value: 10 }, as(admin))

    await settle(() => expect(received(asAdmin, 'settings')).toHaveLength(2))
    expect(received(asAdmin, 'settings')[0]).toMatchObject({ data: { key: 'refreshGraceSeconds', value: 20 } })
    expect(received(asOperator, 'settings')).toEqual([])
    expect(received(asMember, 'settings')).toEqual([])
  })

  it('an internal change is published like an external one', async () => {
    const asAdmin = await connectAs(admin)
    await app.service('users').patch(other.id, { enabled: true })
    await settle(() => expect(received(asAdmin, 'users')).toHaveLength(1))
  })

  it('a connection whose session was revoked cannot join', async () => {
    const connection = await connect()
    const { sessionId, accessToken } = await tokenFor(member)
    await app.get('sessions').revoke(sessionId)
    await expect(connection.client.authenticate({ strategy: 'jwt', accessToken })).rejects.toMatchObject({ code: 401 })
    await app.service('users').patch(member.id, { enabled: true }, as(admin))
    await settle(() => undefined)
    expect(connection.events).toEqual([])
  })
})

describe('forced re-authentication', () => {
  const restore = async (user: User) => {
    await app.service('users').patch(user.id, { role: user.role, enabled: true })
  }

  it('a role change closes every socket of that user, and only theirs', async () => {
    const [first, second, bystander] = await Promise.all([connectAs(operator), connectAs(operator), connectAs(admin)])
    await app.service('users').patch(operator.id, { role: 'user' }, as(admin))

    await settle(() => {
      expect(first.disconnects).toEqual(['io server disconnect'])
      expect(second.disconnects).toEqual(['io server disconnect'])
    })
    expect(bystander.disconnects).toEqual([])
    expect(received(bystander, 'users')).toHaveLength(1)

    // Reconnected, the old token no longer holds: its role is stale.
    first.socket.connect()
    await vi.waitFor(() => expect(first.socket.connected).toBe(true))
    await expect(
      first.client.authenticate({ strategy: 'jwt', accessToken: first.accessToken ?? '' })
    ).rejects.toMatchObject({ code: 401 })

    // With a token for the new role, it is a plain user's connection: no
    // longer in roles/operator.
    const { accessToken } = await tokenFor({ ...operator, role: 'user' })
    await first.client.authenticate({ strategy: 'jwt', accessToken })
    await app.service('users').patch(member.id, { enabled: true }, as(admin))
    await settle(() => expect(received(bystander, 'users')).toHaveLength(2))
    expect(received(first, 'users')).toEqual([])

    await restore(operator)
  })

  it('disabling an account closes its sockets', async () => {
    const connection = await connectAs(member)
    await app.service('users').patch(member.id, { enabled: false }, as(admin))
    await settle(() => expect(connection.disconnects).toEqual(['io server disconnect']))
    await restore(member)
  })

  it('a patch that changes neither role nor state closes nothing', async () => {
    const connection = await connectAs(member)
    await app.service('users').patch(member.id, { role: 'user', enabled: true }, as(admin))
    await settle(() => expect(received(connection, 'users')).toHaveLength(1))
    expect(connection.disconnects).toEqual([])
  })

  it('revoking a session closes that session’s sockets, not the user’s others', async () => {
    const [revoked, kept] = await Promise.all([connectAs(member), connectAs(member)])
    await app.get('sessions').revoke(revoked.sessionId ?? '')
    await settle(() => expect(revoked.disconnects).toEqual(['io server disconnect']))
    expect(kept.disconnects).toEqual([])
  })

  it('refresh token reuse revokes the session and closes its sockets', async () => {
    const connection = await connect()
    const { session, refreshToken } = await app.get('sessions').issue(member.id)
    const accessToken = await app
      .service('authentication')
      .createAccessToken({ sid: session.id, role: member.role }, { subject: member.id })
    await connection.client.authenticate({ strategy: 'jwt', accessToken })

    // Rotate, then present the rotated-away token outside the grace window.
    expect((await app.get('sessions').refresh(refreshToken)).status).toBe('rotated')
    await app
      .get('knex')('authRefreshTokens')
      .where({ tokenHash: hashRefreshToken(refreshToken) })
      .update({ rotatedAt: new Date(0) })
    expect((await app.get('sessions').refresh(refreshToken)).status).toBe('reuse')
    await settle(() => expect(connection.disconnects).toEqual(['io server disconnect']))
  })

  it('logout over the socket leaves every channel', async () => {
    const connection = await connectAs(member)
    await connection.client.logout()
    await app.service('users').patch(member.id, { enabled: true }, as(admin))
    await settle(() => undefined)
    expect(connection.events).toEqual([])
  })
})
