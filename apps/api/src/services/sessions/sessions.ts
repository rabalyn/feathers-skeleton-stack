import { subject } from '@casl/ability'
import { Forbidden, MethodNotAllowed, NotFound } from '@feathersjs/errors'
import type { Id, NullableId, Params } from '@feathersjs/feathers'
import { KnexService } from '@feathersjs/knex'
import { hooks as schemaHooks, resolve, virtual } from '@feathersjs/schema'
import { Type, getValidator, querySyntax, type Static } from '@feathersjs/typebox'
import type { Application } from '../../app.js'
import { recordAudit } from '../../audit.js'
import { publishTo, roleChannel, userChannel } from '../../channels.js'
import type { HookContext } from '../../declarations.js'
import { PAGINATE } from '../../paginate.js'
import { queryValidator } from '../../validators.js'

// Sessions (ADR 0010, 0011): the caller's own logins, every login for
// admins and operators. Only active sessions are listed; revoked and expired
// ones are in the audit log, not here. Revoking is `remove`, which sets
// revoked_at and ends the session's sockets but keeps the row, since reuse
// detection needs it until the family expires. Sessions are created by
// logging in, never through this service.

export const SESSIONS_PATH = 'sessions'
export const SESSION_EXTERNAL_METHODS = ['find', 'get', 'remove'] as const

const toIso = (value: unknown) => (value instanceof Date ? value.toISOString() : (value as string))

export const sessionSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    userId: Type.String({ format: 'uuid' }),
    issuedAt: Type.String({ format: 'date-time' }),
    // Moves with every refresh, so it is as precise as the access token's
    // lifetime.
    lastUsedAt: Type.String({ format: 'date-time' }),
    idleExpiresAt: Type.String({ format: 'date-time' }),
    familyExpiresAt: Type.String({ format: 'date-time' }),
    // Set only on the result of a revocation.
    revokedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    // Absent where the caller may not see it: operators, on others' sessions.
    userAgent: Type.Optional(Type.Union([Type.String(), Type.Null()]))
  },
  { $id: 'Session', additionalProperties: false }
)
export type Session = Static<typeof sessionSchema>

// The columns this service reads. The SAML columns (the IdP session, for
// logout) stay internal (ADR 0005).
const SESSION_COLUMNS = ['id', 'userId', 'issuedAt', 'lastUsedAt', 'idleExpiresAt', 'familyExpiresAt', 'revokedAt', 'userAgent']

export const sessionResolver = resolve<Session, HookContext>({
  issuedAt: virtual(async (session) => toIso(session.issuedAt)),
  lastUsedAt: virtual(async (session) => toIso(session.lastUsedAt)),
  idleExpiresAt: virtual(async (session) => toIso(session.idleExpiresAt)),
  familyExpiresAt: virtual(async (session) => toIso(session.familyExpiresAt)),
  revokedAt: virtual(async (session) => (session.revokedAt ? toIso(session.revokedAt) : null))
})

// Field restrictions come from the caller's ability, so abilities.ts stays
// the one place they are declared (ADR 0011). feathers-casl filters the
// internal result only, and the transport sends this dispatch; published
// events are filtered per connection by the same rule (ADR 0012).
export const sessionExternalResolver = resolve<Session, HookContext>({
  userAgent: async (value, session, context) => {
    const ability = context.params.ability
    if (ability && !ability.can('read', subject(SESSIONS_PATH, { ...session }), 'userAgent')) return undefined
    return value
  }
})

export const sessionQueryProperties = Type.Pick(sessionSchema, ['id', 'userId', 'issuedAt', 'lastUsedAt'])
export const sessionQuerySchema = Type.Intersect(
  [querySyntax(sessionQueryProperties), Type.Object({}, { additionalProperties: false })],
  { additionalProperties: false }
)
export type SessionQuery = Static<typeof sessionQuerySchema>
export const sessionQueryValidator = getValidator(sessionQuerySchema, queryValidator)

export type SessionParams = Params<SessionQuery>

export class SessionService extends KnexService<Session, never, SessionParams> {
  constructor(
    private readonly application: Application,
    options: ConstructorParameters<typeof KnexService<Session, never, SessionParams>>[0]
  ) {
    super(options)
  }

  // Revocation, one session at a time. The lookup carries the caller's
  // query, into which feathers-casl has put the revoke conditions.
  async _remove(id: null, params?: SessionParams): Promise<Session[]>
  async _remove(id: Id, params?: SessionParams): Promise<Session>
  async _remove(id: NullableId, params?: SessionParams): Promise<Session | Session[]> {
    if (id === null) throw new MethodNotAllowed('Sessions are revoked one at a time')
    const session = await this._get(id, params).catch(async (error: unknown) => {
      // A session the caller may read but not revoke is a 403, one they
      // may not read or that is no longer active a 404 (ADR 0011).
      const ability = params?.ability
      if (error instanceof NotFound && ability) {
        const readable = await this._get(id, { query: activeQuery() }).catch(() => undefined)
        if (readable && ability.can('read', subject(SESSIONS_PATH, { ...readable }))) {
          throw new Forbidden('Only its owner or an admin revokes a session')
        }
      }
      throw error
    })
    await this.application.get('sessions').revoke(String(id))
    await recordAudit(this.application.get('knex'), {
      actorId: (params?.user as { id: string } | undefined)?.id ?? null,
      action: 'sessions.revoke',
      resourceType: SESSIONS_PATH,
      resourceId: String(id),
      detail: { userId: session.userId }
    })
    return { ...session, revokedAt: new Date().toISOString() }
  }
}

// Active only, whatever the caller asks for, and never more than the
// columns above.
const activeQuery = () => {
  const now = new Date().toISOString()
  return { $select: SESSION_COLUMNS, revokedAt: null, idleExpiresAt: { $gt: now }, familyExpiresAt: { $gt: now } } as SessionQuery
}
const activeOnly = async (context: HookContext<SessionService>) => {
  context.params.query = { ...context.params.query, ...activeQuery() }
}

// Newest first unless the caller sorts.
const newestFirst = async (context: HookContext<SessionService>) => {
  const query = context.params.query ?? {}
  if (!query.$sort) context.params.query = { ...query, $sort: { lastUsedAt: -1, id: -1 } }
}

export const sessions = (app: Application) => {
  app.use(
    SESSIONS_PATH,
    new SessionService(app, { Model: app.get('knex'), name: 'auth_sessions', id: 'id', paginate: PAGINATE }),
    { methods: [...SESSION_EXTERNAL_METHODS] }
  )
  app.service(SESSIONS_PATH).hooks({
    around: {
      all: [schemaHooks.resolveExternal(sessionExternalResolver), schemaHooks.resolveResult(sessionResolver)]
    },
    before: {
      all: [schemaHooks.validateQuery(sessionQueryValidator), activeOnly],
      find: [newestFirst]
    }
  })

  // A revocation concerns the session's owner, and the admins and operators
  // who see all sessions (ADR 0011, 0012).
  app.service(SESSIONS_PATH).publish(
    publishTo(app, (session) => [userChannel(String(session.userId)), roleChannel('admin'), roleChannel('operator')], {
      availableFields: SESSION_COLUMNS
    })
  )
}

declare module '../../app.js' {
  interface ServiceTypes {
    [SESSIONS_PATH]: SessionService
  }
}
