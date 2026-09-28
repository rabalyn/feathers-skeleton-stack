import type { AuthenticationResult } from '@feathersjs/authentication'
import type { HookContext, Params, RealTimeConnection } from '@feathersjs/feathers'
import { getChannelsWithReadAbility } from 'feathers-casl'
import { defineAbilitiesFor, type AppAbility, type Role } from './abilities.js'
import type { Application } from './app.js'

// Real-time delivery (ADR 0012). A connection joins channels derived from
// the session it authenticated with; a publisher names candidate channels
// and the connection's CASL ability decides, per event, whether it receives
// the record and which fields of it.

export const userChannel = (userId: string) => `users/${userId}`
export const roleChannel = (role: Exclude<Role, 'user'>) => `roles/${role}`

// What the server knows about an authenticated connection, beside what
// Feathers keeps on it (`authentication`, `user`).
interface SessionConnection extends RealTimeConnection {
  ability?: AppAbility
  sessionId?: string
  user?: { id: string; role: Role }
}

const leaveAll = (app: Application, connection: RealTimeConnection) => {
  for (const name of app.channels) app.channel(name).leave(connection)
}

// Membership is recomputed from scratch on every (re-)authentication.
const join = (app: Application, connection: SessionConnection, result: AuthenticationResult) => {
  leaveAll(app, connection)
  delete connection.ability
  delete connection.sessionId

  const user = result.user as SessionConnection['user']
  const authentication = result.authentication as { strategy?: unknown; payload?: { sid?: unknown } } | undefined
  const sessionId = authentication?.payload?.sid
  // Only the session-checked access token attaches a connection; anything
  // else leaves it anonymous, in no channel.
  if (authentication?.strategy !== 'jwt' || !user || typeof sessionId !== 'string') return

  connection.ability = defineAbilitiesFor(user)
  connection.sessionId = sessionId
  app.channel(userChannel(user.id)).join(connection)
  if (user.role !== 'user') app.channel(roleChannel(user.role)).join(connection)
}

// Ends the connections matching `which`: they leave every channel and the
// socket is closed, so the client has to authenticate again under what now
// holds (ADR 0012). Feathers' own 'disconnect' strips the connection's
// authentication and closes its socket.
export const endConnections = (app: Application, which: (connection: SessionConnection) => boolean) => {
  if (!app.channels.length) return
  const connections = new Set(app.channel(app.channels).connections as SessionConnection[])
  for (const connection of connections) {
    if (!which(connection)) continue
    leaveAll(app, connection)
    app.emit('disconnect', connection)
  }
}

export const endUserConnections = (app: Application, userId: string) =>
  endConnections(app, (connection) => connection.user?.id === userId)

export const endSessionConnections = (app: Application, sessionId: string) =>
  endConnections(app, (connection) => connection.sessionId === sessionId)

// The external form of one event's record: the payload REST would have
// returned (ADR 0005). `data` is one element of the service's internal
// result, `context.dispatch` its resolved counterpart.
const dispatched = (data: unknown, context: HookContext): unknown => {
  const result: unknown = context.result
  const dispatch: unknown = context.dispatch
  if (Array.isArray(result)) {
    const index = result.indexOf(data)
    return Array.isArray(dispatch) && index >= 0 ? dispatch[index] : undefined
  }
  return dispatch
}

// Builds a service publisher from the candidate channels of an event. The
// per-connection filter runs on the resolved payload, and whatever it cannot
// place goes nowhere.
export const publishTo =
  (app: Application, candidates: (payload: Record<string, unknown>, context: HookContext) => string[]) =>
  (data: unknown, context: HookContext): ReturnType<typeof getChannelsWithReadAbility> => {
    const payload = dispatched(data, context)
    if (!payload || typeof payload !== 'object') {
      app.get('logger').warn({ path: context.path, method: context.method }, 'event without a resolved payload: not published')
      return undefined
    }
    // Only channels somebody is in: naming one creates it, and a channel that
    // was never joined is never cleaned up.
    const names = candidates(payload as Record<string, unknown>, context).filter((name) => app.channels.includes(name))
    if (!names.length) return undefined
    const channels = app.channel(names)
    return getChannelsWithReadAbility(app, payload, context, { channels, channelOnError: [] })
  }

export const channels = (app: Application) => {
  // Anonymous connections join nothing: no 'connection' handler.
  app.on('login', (result: AuthenticationResult, { connection }: Params) => {
    if (connection) join(app, connection, result)
  })
  app.on('logout', (_result: AuthenticationResult, { connection }: Params) => {
    if (connection) {
      leaveAll(app, connection)
      delete (connection as SessionConnection).ability
      delete (connection as SessionConnection).sessionId
    }
  })
}
