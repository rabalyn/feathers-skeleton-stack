import { subject } from '@casl/ability'
import { MethodNotAllowed } from '@feathersjs/errors'
import type { Id, NullableId, Params } from '@feathersjs/feathers'
import type { AuthSession } from '../../auth/sessions.js'
import { KnexService } from '@feathersjs/knex'
import { hooks as schemaHooks, resolve, virtual } from '@feathersjs/schema'
import { Type, getValidator, querySyntax, type Static } from '@feathersjs/typebox'
import type { Application } from '../../app.js'
import { recordAudit } from '../../audit.js'
import { publishTo, subjectChannel } from '../../channels.js'
import type { HookContext } from '../../declarations.js'
import { PAGINATE } from '../../paginate.js'
import { queryValidator } from '../../validators.js'

// Sessions (ADR 0010, 0011): who is logged in, under `sessions.read`.
// Only active sessions are listed; revoked and expired ones are in the audit
// log, not here. Revoking is `remove`, which sets revoked_at and ends the
// session's sockets but keeps the row, since reuse detection needs it until
// the family expires. Sessions are created by logging in, never through this
// service, so its events come from the session store: a login is `created`,
// a refresh `patched`, any revocation `removed` (publishSession below).

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
    // Absent where the caller may not see it: for operators.
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

  // Revocation, one session at a time; one no longer active is a 404.
  async _remove(id: null, params?: SessionParams): Promise<Session[]>
  async _remove(id: Id, params?: SessionParams): Promise<Session>
  async _remove(id: NullableId, params?: SessionParams): Promise<Session | Session[]> {
    if (id === null) throw new MethodNotAllowed('Sessions are revoked one at a time')
    const session = await this._get(id, params)
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
const activeOnly = async (context: HookContext<SessionService>) => {
  const now = new Date().toISOString()
  context.params.query = {
    ...context.params.query,
    $select: SESSION_COLUMNS,
    revokedAt: null,
    idleExpiresAt: { $gt: now },
    familyExpiresAt: { $gt: now }
  } as SessionQuery
}

// The session store publishes the revocation, as it does every other one.
const noEvent = async (context: HookContext<SessionService>) => {
  context.event = null
}

// Publishes a change the session store made, in the external form a `get`
// would return. The channel filter drops what a connection may not read
// (ADR 0012), so the payload carries every field.
export const publishSession = (app: Application, event: 'created' | 'patched' | 'removed', session: AuthSession) => {
  const record: Session = {
    id: session.id,
    userId: session.userId,
    issuedAt: toIso(session.issuedAt),
    lastUsedAt: toIso(session.lastUsedAt),
    idleExpiresAt: toIso(session.idleExpiresAt),
    familyExpiresAt: toIso(session.familyExpiresAt),
    revokedAt: session.revokedAt ? toIso(session.revokedAt) : null,
    userAgent: session.userAgent
  }
  const method = { created: 'create', patched: 'patch', removed: 'remove' }[event]
  const service = app.service(SESSIONS_PATH)
  service.emit(event, record, { app, service, path: SESSIONS_PATH, method, params: {}, result: record, dispatch: record })
}

// Newest first unless the caller sorts.
const newestFirst = async (context: HookContext<SessionService>) => {
  const query = context.params.query ?? {}
  if (!query.$sort) context.params.query = { ...query, $sort: { lastUsedAt: -1, id: -1 } }
}

export const sessions = (app: Application) => {
  app.use(
    SESSIONS_PATH,
    new SessionService(app, {
      Model: app.get('knex'),
      name: 'auth_sessions',
      id: 'id',
      paginate: PAGINATE,
      // Every field: feathers-casl otherwise takes a rule without fields to
      // grant none, and one field rule would restrict every reader.
      casl: { availableFields: [...SESSION_COLUMNS] }
    } as ConstructorParameters<typeof KnexService<Session, never, SessionParams>>[0]),
    { methods: [...SESSION_EXTERNAL_METHODS] }
  )
  app.service(SESSIONS_PATH).hooks({
    around: {
      all: [schemaHooks.resolveExternal(sessionExternalResolver), schemaHooks.resolveResult(sessionResolver)]
    },
    before: {
      all: [schemaHooks.validateQuery(sessionQueryValidator), activeOnly],
      find: [newestFirst]
    },
    after: {
      remove: [noEvent]
    }
  })

  // Sessions concern whoever reads them (ADR 0011, 0012).
  app.service(SESSIONS_PATH).publish(publishTo(app, () => [subjectChannel(SESSIONS_PATH)]))
}

declare module '../../app.js' {
  interface ServiceTypes {
    [SESSIONS_PATH]: SessionService
  }
}
