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
import { grantRoles, makeUser, roleIdOf } from '../support/roles.js'

// ADR 0012 over real WebSockets through the typed client: which connection
// receives which event, and that changed roles, a change to what a role
// grants, a disabled account or a revoked session closes the sockets it
// concerns. The users hold roles of the test's own (ADR 0035): the operator
// reads users, documents and sessions, the members keep their own documents.

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
  admin = await makeUser(app, 'ad01admn', 'admin', { email: null })
  operator = await makeUser(app, 'op01oper', ['users.read', 'documents.all', 'sessions.read'], { email: null })
  member = await makeUser(app, 'us01user', ['documents.own'], { email: null })
  other = await makeUser(app, 'us02othr', ['documents.own'], { email: null })
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
  for (const path of ['users', 'settings', 'documents', 'data-exports', 'sessions'] as const) {
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
    .createAccessToken({ sid: session.id }, { subject: user.id })
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

  it('logins, refreshes and revocations go to admins and operators, operators without the browser (ADR 0011)', async () => {
    const [asAdmin, asOperator, asOwner] = await Promise.all([connectAs(admin), connectAs(operator), connectAs(member)])
    const events = (connection: Connection) =>
      received(connection, 'sessions').filter((e) => (e.data as { userId?: string }).userId === other.id)

    // A login: the session store issues it, not the service.
    const { session, refreshToken } = await app.get('sessions').issue(other.id, { userAgent: 'Firefox' })
    await settle(() => {
      for (const connection of [asAdmin, asOperator]) expect(events(connection)).toHaveLength(1)
    })
    expect(events(asAdmin)[0]).toMatchObject({ event: 'created', data: { id: session.id, userAgent: 'Firefox', revokedAt: null } })
    expect(events(asOperator)[0]).toMatchObject({ event: 'created', data: { id: session.id, lastUsedAt: expect.any(String) } })
    expect(events(asOperator)[0]?.data).not.toHaveProperty('userAgent')

    // A refresh moves lastUsedAt.
    expect((await app.get('sessions').refresh(refreshToken)).status).toBe('rotated')
    await settle(() => {
      for (const connection of [asAdmin, asOperator]) expect(events(connection).map((e) => e.event)).toEqual(['created', 'patched'])
    })

    // Revoked through the service: one event, not the service's and the store's.
    await app.service('sessions').remove(session.id, as(admin))
    await settle(() => {
      for (const connection of [asAdmin, asOperator]) {
        expect(events(connection).map((e) => e.event)).toEqual(['created', 'patched', 'removed'])
      }
    })
    expect(events(asAdmin)[2]).toMatchObject({ data: { id: session.id, revokedAt: expect.any(String) } })
    // A user sees no sessions, not even of their own logins.
    expect(received(asOwner, 'sessions')).toEqual([])
  })

  it('a logout is published as a revocation', async () => {
    const asAdmin = await connectAs(admin)
    const { session } = await app.get('sessions').issue(other.id)
    await app.get('sessions').revoke(session.id)
    await settle(() =>
      expect(received(asAdmin, 'sessions').filter((e) => (e.data as { id: string }).id === session.id).map((e) => e.event)).toEqual([
        'created',
        'removed'
      ])
    )
  })

  it('the payload is the one REST returns, not the internal result', async () => {
    const asAdmin = await connectAs(admin)
    const viaRest = await app.service('users').patch(other.id, { enabled: true }, as(admin))
    await settle(() => expect(received(asAdmin, 'users')).toHaveLength(1))
    expect(received(asAdmin, 'users')[0]?.data).toEqual(JSON.parse(JSON.stringify(viaRest)))
  })

  it('a role goes to admins in full, to readers of users by name, and to no plain user (ADR 0011)', async () => {
    const [asAdmin, asOperator, asMember] = await Promise.all([connectAs(admin), connectAs(operator), connectAs(member)])
    for (const connection of [asAdmin, asOperator, asMember]) {
      for (const event of ['created', 'patched', 'removed'] as const) {
        connection.client.service('roles').on(event, (data: unknown) => connection.events.push({ path: 'roles', event, data }))
      }
    }
    const role = await app.service('roles').create({ key: 'live-role', name: { de: 'Live', en: 'Live' }, permissions: ['queues.read'] }, as(admin))

    await settle(() => {
      for (const connection of [asAdmin, asOperator]) expect(received(connection, 'roles')).toHaveLength(1)
    })
    expect(received(asAdmin, 'roles')[0]).toMatchObject({ event: 'created', data: { id: role.id, permissions: ['queues.read'] } })
    expect(received(asOperator, 'roles')[0]).toMatchObject({ data: { id: role.id, key: 'live-role', name: { en: 'Live' } } })
    expect(received(asOperator, 'roles')[0]?.data).not.toHaveProperty('permissions')
    expect(received(asMember, 'roles')).toEqual([])
    await app.service('roles').remove(role.id, as(admin))
  })

  it('a setting goes to holders of settings.manage only (ADR 0011)', async () => {
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
  const restore = async (user: User, role: string) => {
    await grantRoles(app, user.id, [role])
    await app.service('users').patch(user.id, { enabled: true })
  }

  const reconnect = async (connection: Connection) => {
    connection.socket.connect()
    await vi.waitFor(() => expect(connection.socket.connected).toBe(true))
    // The token carries no role (ADR 0010): it still holds, and the
    // connection rejoins under what the user may now read.
    await connection.client.authenticate({ strategy: 'jwt', accessToken: connection.accessToken ?? '' })
  }

  it('a role change closes every socket of that user, and only theirs', async () => {
    const [first, second, bystander] = await Promise.all([connectAs(operator), connectAs(operator), connectAs(admin)])
    await app.service('user-roles').patch(operator.id, { roleIds: [await roleIdOf(app, 'us01user')] }, as(admin))

    await settle(() => {
      expect(first.disconnects).toEqual(['io server disconnect'])
      expect(second.disconnects).toEqual(['io server disconnect'])
    })
    expect(bystander.disconnects).toEqual([])
    expect(received(bystander, 'users')).toHaveLength(1)

    // Reconnected, it is a member's connection: no longer in
    // subjects/users.
    await reconnect(first)
    await app.service('users').patch(member.id, { enabled: true }, as(admin))
    await settle(() => expect(received(bystander, 'users')).toHaveLength(2))
    expect(received(first, 'users')).toEqual([])

    await restore(operator, 'op01oper')
  })

  it("a change to what a role grants closes its holders' sockets, and only theirs", async () => {
    const operatorRole = await app.service('roles').get(await roleIdOf(app, 'op01oper'))
    const [holder, bystander, userHolder] = await Promise.all([connectAs(operator), connectAs(admin), connectAs(member)])
    await app
      .service('roles')
      .patch(operatorRole.id, { permissions: (operatorRole.permissions ?? []).filter((key) => key !== 'users.read') }, as(admin))

    await settle(() => expect(holder.disconnects).toEqual(['io server disconnect']))
    expect(bystander.disconnects).toEqual([])
    expect(userHolder.disconnects).toEqual([])

    // Rejoined without users.read, it sees no one else's record.
    await reconnect(holder)
    await app.service('users').patch(other.id, { enabled: true }, as(admin))
    await settle(() => expect(received(bystander, 'users').filter((e) => (e.data as User).id === other.id)).toHaveLength(1))
    expect(received(holder, 'users')).toEqual([])

    await app.service('roles').patch(operatorRole.id, { permissions: operatorRole.permissions ?? [] }, as(admin))
  })

  it('renaming a role closes nothing', async () => {
    const operatorRole = await app.service('roles').get(await roleIdOf(app, 'op01oper'))
    const holder = await connectAs(operator)
    await app.service('roles').patch(operatorRole.id, { name: operatorRole.name }, as(admin))
    await settle(() => undefined)
    expect(holder.disconnects).toEqual([])
  })

  it('disabling an account closes its sockets', async () => {
    const connection = await connectAs(member)
    await app.service('users').patch(member.id, { enabled: false }, as(admin))
    await settle(() => expect(connection.disconnects).toEqual(['io server disconnect']))
    await restore(member, 'us01user')
  })

  it('a change that changes neither roles nor state closes nothing', async () => {
    const connection = await connectAs(member)
    await app.service('user-roles').patch(member.id, { roleIds: member.roleIds }, as(admin))
    await app.service('users').patch(member.id, { enabled: true }, as(admin))
    await settle(() => expect(received(connection, 'users')).toHaveLength(2))
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
      .createAccessToken({ sid: session.id }, { subject: member.id })
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

// Decided 2026-10-02 (ADR 0018): a WebSocket is opened from the
// application's own origin only, and every call gets an answer.
describe('socket transport', () => {
  const handshake = (origin?: string) =>
    new Promise<string>((resolve) => {
      const socket = io(base, {
        path: SOCKET_PATH,
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
        ...(origin ? { extraHeaders: { origin } } : {})
      })
      socket.once('connect', () => {
        socket.disconnect()
        resolve('connected')
      })
      socket.once('connect_error', () => {
        socket.disconnect()
        resolve('refused')
      })
    })

  it('refuses a handshake from another origin, or without one', async () => {
    expect(await handshake('https://evil.test')).toBe('refused')
    expect(await handshake()).toBe('refused')
    expect(await handshake(PUBLIC_ORIGIN)).toBe('connected')
  })

  it('answers a method no service offers with MethodNotAllowed instead of leaving it pending', async () => {
    const { socket } = await connectAs(member)
    const call = (...args: unknown[]) =>
      new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no answer')), 2000)
        socket.emit(...(args as [string]), (error: unknown) => {
          clearTimeout(timer)
          resolve(error)
        })
      })
    for (const method of ['update', '_find', 'nonsense']) {
      expect(await call(method, 'documents', 'x', {})).toMatchObject({ name: 'MethodNotAllowed', code: 405 })
    }
    // Real methods are untouched.
    expect(await call('find', 'documents', {})).toBeNull()
  })
})
