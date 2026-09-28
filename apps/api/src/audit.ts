import type { Knex } from 'knex'
import { currentRequest } from './request-context.js'

// Audit events (ADR 0013, 0018): authentication, role changes, settings
// changes and other administrative actions. Stored in PostgreSQL under the
// audit retention rule; reading, export and cleanup arrive with ADR 0013.
//
// `detail` holds identifiers and changed values of configuration, never
// request bodies, credentials or assertion contents.

export type AuditAction =
  | 'breakglass.create'
  | 'breakglass.rotate'
  | 'data-exports.create'
  | 'data-exports.download'
  | 'login'
  | 'login.refused'
  | 'logout'
  | 'mail.campaign.send'
  | 'mail.template.activate'
  | 'mail.template.save'
  | 'session.reuse-detected'
  | 'sessions.revoke'
  | 'settings.update'
  | 'users.erase'
  | 'users.patch'

export interface AuditEvent {
  actorId: string | null
  action: AuditAction
  resourceType: string
  resourceId?: string | null
  requestId?: string | null
  detail?: Record<string, unknown>
}

// Takes the camelCase Knex (or a transaction on it), so the event can share
// the transaction of the change it records.
export const recordAudit = async (knex: Knex | Knex.Transaction, event: AuditEvent): Promise<void> => {
  await knex('auditEvents').insert({
    actorId: event.actorId,
    action: event.action,
    resourceType: event.resourceType,
    resourceId: event.resourceId ?? null,
    // The request the change happened in, unless the caller names one.
    requestId: event.requestId ?? currentRequest()?.requestId ?? null,
    detail: JSON.stringify(event.detail ?? {})
  })
}
