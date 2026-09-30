import { Unavailable } from '@feathersjs/errors'
import type { Application } from './app.js'
import { recordAudit } from './audit.js'
import { loadAccess } from './permissions.js'

// Maintenance mode (ADR 0025): a runtime setting an admin switches in the
// UI. While it is on, only those who may switch it off again use the
// application; everyone else, and every API token, is answered 503 with
// `data.maintenance`, which the browser takes to its maintenance page.

// Whoever may change settings may also switch maintenance off, so holding
// this permission is what lets a person in: nobody is locked out by a
// setting they cannot undo.
export const MAINTENANCE_BYPASS = 'settings.manage'

export const mayBypassMaintenance = (permissions: readonly string[]): boolean => permissions.includes(MAINTENANCE_BYPASS)

export const maintenanceUnavailable = (): Unavailable => new Unavailable('Maintenance mode is active', { maintenance: true })

export const inMaintenance = (app: Application): Promise<boolean> => app.get('settings').get('maintenanceMode')

// Refuses a person during maintenance unless they may bypass it.
export const assertNotLockedOut = async (app: Application, userId: string): Promise<void> => {
  if (!(await inMaintenance(app))) return
  const { permissions } = await loadAccess(app.get('knex'), userId)
  if (!mayBypassMaintenance(permissions)) throw maintenanceUnavailable()
}

// Switching maintenance on ends every active session of those who may not
// bypass it; their sockets close with it (ADR 0010, 0012). Switching it off
// ends nothing. Both are audit events of their own, beside the setting's.
export const maintenanceChanged = async (
  app: Application,
  { from, to, actorId }: { from: unknown; to: unknown; actorId: string | null }
): Promise<void> => {
  if (from === to) return
  const knex = app.get('knex')
  if (to !== true) {
    await recordAudit(knex, { actorId, action: 'maintenance.disable', resourceType: 'settings', resourceId: 'maintenanceMode' })
    return
  }
  const active: { id: string; userId: string }[] = await knex('authSessions')
    .whereNull('revokedAt')
    .where('idleExpiresAt', '>', knex.fn.now())
    .where('familyExpiresAt', '>', knex.fn.now())
    .select('id', 'userId')
  const bypass = new Map<string, boolean>()
  for (const userId of new Set(active.map((session) => session.userId))) {
    bypass.set(userId, mayBypassMaintenance((await loadAccess(knex, userId)).permissions))
  }
  let revoked = 0
  for (const session of active) {
    if (bypass.get(session.userId)) continue
    if (await app.get('sessions').revoke(session.id)) revoked++
  }
  await recordAudit(knex, {
    actorId,
    action: 'maintenance.enable',
    resourceType: 'settings',
    resourceId: 'maintenanceMode',
    detail: { revokedSessions: revoked }
  })
  app.get('logger').warn({ user_ref: actorId, revoked_sessions: revoked }, 'maintenance mode enabled')
}
