import type { Params } from '@feathersjs/feathers'
import { KnexService } from '@feathersjs/knex'
import { hooks as schemaHooks, resolve, virtual } from '@feathersjs/schema'
import { Type, querySyntax, type Static } from '@feathersjs/typebox'
import type { Application } from '../../app.js'
import { publishNothing } from '../../channels.js'
import type { HookContext } from '../../declarations.js'
import { PAGINATE } from '../../paginate.js'
import { queryValidator, lazyValidator } from '../../validators.js'

// Reading audit events (ADR 0013, 0011): admins and operators read all,
// everyone else the events they caused. Read-only: events are written by
// recordAudit() in the transaction of the change they record, never through
// this service, which therefore publishes nothing.

export const AUDIT_EVENTS_PATH = 'audit-events'
export const AUDIT_EVENT_EXTERNAL_METHODS = ['find', 'get'] as const

const toIso = (value: unknown) => (value instanceof Date ? value.toISOString() : (value as string))
const nullableString = Type.Union([Type.String(), Type.Null()])

export const auditEventSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    occurredAt: Type.String({ format: 'date-time' }),
    // Null for the system.
    actorId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
    action: Type.String(),
    resourceType: Type.String(),
    resourceId: nullableString,
    requestId: nullableString,
    detail: Type.Record(Type.String(), Type.Unknown())
  },
  { $id: 'AuditEvent', additionalProperties: false }
)
export type AuditEvent = Static<typeof auditEventSchema>

export const auditEventResolver = resolve<AuditEvent, HookContext>({
  occurredAt: virtual(async (event) => toIso(event.occurredAt))
})
export const auditEventExternalResolver = resolve<AuditEvent, HookContext>({})

export const auditEventQueryProperties = Type.Pick(auditEventSchema, [
  'id',
  'occurredAt',
  'actorId',
  'action',
  'resourceType',
  'resourceId',
  'requestId'
])
export const auditEventQuerySchema = Type.Intersect(
  [querySyntax(auditEventQueryProperties), Type.Object({}, { additionalProperties: false })],
  { additionalProperties: false }
)
export type AuditEventQuery = Static<typeof auditEventQuerySchema>
export const auditEventQueryValidator = lazyValidator(auditEventQuerySchema, queryValidator)

export type AuditEventParams = Params<AuditEventQuery>

export class AuditEventService extends KnexService<AuditEvent, never, AuditEventParams> {}

// Newest first unless the caller sorts.
const newestFirst = async (context: HookContext<AuditEventService>) => {
  const query = context.params.query ?? {}
  if (!query.$sort) context.params.query = { ...query, $sort: { occurredAt: -1, id: -1 } }
}

export const auditEvents = (app: Application) => {
  app.use(AUDIT_EVENTS_PATH, new AuditEventService({ Model: app.get('knex'), name: 'audit_events', id: 'id', paginate: PAGINATE }), {
    methods: [...AUDIT_EVENT_EXTERNAL_METHODS]
  })
  app.service(AUDIT_EVENTS_PATH).hooks({
    around: {
      all: [schemaHooks.resolveExternal(auditEventExternalResolver), schemaHooks.resolveResult(auditEventResolver)]
    },
    before: {
      all: [schemaHooks.validateQuery(auditEventQueryValidator)],
      find: [newestFirst]
    }
  })
  // Events are recorded beside the changes, not through this service.
  app.service(AUDIT_EVENTS_PATH).publish(publishNothing)
}

declare module '../../app.js' {
  interface ServiceTypes {
    [AUDIT_EVENTS_PATH]: AuditEventService
  }
}
