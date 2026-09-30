import { BadRequest, Forbidden, MethodNotAllowed, NotFound } from '@feathersjs/errors'
import { hooks as schemaHooks } from '@feathersjs/schema'
import type { NullableId, Params } from '@feathersjs/feathers'
import { Type, getValidator, type Static } from '@feathersjs/typebox'
import { ROLE_MANAGEMENT } from '../../abilities.js'
import type { Application } from '../../app.js'
import { endSessionConnections, joinAs, publishNothing, type ChannelUser } from '../../channels.js'
import { loadAccess } from '../../permissions.js'
import { dataValidator } from '../../validators.js'

// Read-only view-as (ADR 0028): `create` starts viewing the application as
// another person, under `users.view-as`; `remove` ends it, which anybody may
// for their own session. It is state of the caller's session: no token is
// issued in the target's name. The caller's connection re-joins its
// channels at once, under the intersected ability or afterwards the caller's
// own; the session's other connections are closed and re-authenticate.

export const VIEW_AS_PATH = 'view-as'
export const VIEW_AS_EXTERNAL_METHODS = ['create', 'remove'] as const

export const viewAsSchema = Type.Object(
  {
    // Whom the session views as; null once it ended.
    userId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
    expiresAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()])
  },
  { $id: 'ViewAs', additionalProperties: false }
)
export type ViewAs = Static<typeof viewAsSchema>

export const viewAsDataSchema = Type.Object({ userId: Type.String({ format: 'uuid' }) }, { $id: 'ViewAsData', additionalProperties: false })
export type ViewAsData = Static<typeof viewAsDataSchema>
const viewAsDataValidator = getValidator(viewAsDataSchema, dataValidator)

const sessionOf = (params?: Params): string => {
  const sid = (params?.authentication as { payload?: { sid?: unknown } } | undefined)?.payload?.sid
  if (typeof sid !== 'string') throw new BadRequest('View-as needs a session')
  return sid
}

export class ViewAsService {
  constructor(private readonly app: Application) {}

  async create(data: ViewAsData, params?: Params): Promise<ViewAs> {
    const viewer = params?.viewer ?? params?.user
    if (!viewer) throw new BadRequest('View-as needs a user')
    // A session already viewing as somebody has no create here: its
    // intersected ability grants no write (no chaining).
    const target = await this.app.service('users')._get(data.userId)
    const access = await loadAccess(this.app.get('knex'), target.id)
    if (target.id === viewer.id) throw new Forbidden('Nobody views as themselves')
    if (access.permissions.includes(ROLE_MANAGEMENT)) throw new Forbidden('Nobody views as an administrator')
    if (target.authSource === 'local') throw new Forbidden('Nobody views as the break-glass account')
    if (target.erasedAt) throw new Forbidden('Nobody views as an erased account')

    const sessionId = sessionOf(params)
    const session = await this.app.get('sessions').startViewAs(sessionId, target.id)
    this.rejoin(params, sessionId, { user: { ...target, ...access }, viewer })
    return { userId: target.id, expiresAt: session.viewAsExpiresAt?.toISOString() ?? null }
  }

  async remove(id: NullableId, params?: Params): Promise<ViewAs> {
    if (id !== 'current') throw new MethodNotAllowed('Only the current view-as ends')
    const sessionId = sessionOf(params)
    const viewer = params?.viewer ?? params?.user
    if (!viewer || !(await this.app.get('sessions').endViewAs(sessionId, 'stopped'))) throw new NotFound('No view-as to end')
    this.rejoin(params, sessionId, { user: { ...viewer, ...(await loadAccess(this.app.get('knex'), viewer.id)) } })
    return { userId: null, expiresAt: null }
  }

  private rejoin(
    params: Params | undefined,
    sessionId: string,
    who: { user: ChannelUser; viewer?: ChannelUser }
  ) {
    const connection = params?.connection
    if (connection) joinAs(this.app, connection, { ...who, sessionId })
    endSessionConnections(this.app, sessionId, connection)
  }
}

export const viewAs = (app: Application) => {
  app.use(VIEW_AS_PATH, new ViewAsService(app), { methods: [...VIEW_AS_EXTERNAL_METHODS] })
  app.service(VIEW_AS_PATH).hooks({ before: { create: [schemaHooks.validateData(viewAsDataValidator)] } })
  // Starting and ending concern the caller's own connection only (ADR 0028).
  app.service(VIEW_AS_PATH).publish(publishNothing)
}

declare module '../../app.js' {
  interface ServiceTypes {
    [VIEW_AS_PATH]: ViewAsService
  }
}
