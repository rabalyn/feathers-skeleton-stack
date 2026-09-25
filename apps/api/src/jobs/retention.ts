import type { Knex } from 'knex'
import type { SettingsStore } from '../settings/store.js'

// Retention cleanup (ADR 0013, 0024): audit events and expired sessions past
// their retention, deleted in batches, one transaction per batch, so a large
// backlog never holds long locks.

export const RETENTION_BATCH_SIZE = 1000

export interface RetentionResult {
  auditEvents: number
  sessions: number
}

// Runs `batch` until it deletes fewer rows than a full batch.
const inBatches = async (batchSize: number, batch: () => Promise<number>): Promise<number> => {
  let total = 0
  for (;;) {
    const deleted = await batch()
    total += deleted
    if (deleted < batchSize) return total
  }
}

const olderThanDays = (knex: Knex, days: number) => knex.raw('now() - make_interval(days => ?)', [days])

export const retentionCleanup = async (
  knex: Knex,
  settings: SettingsStore,
  batchSize = RETENTION_BATCH_SIZE
): Promise<RetentionResult> => {
  const [auditDays, sessionDays] = await Promise.all([
    settings.get('auditRetentionDays'),
    settings.get('expiredSessionRetentionDays')
  ])

  const auditEvents = await inBatches(batchSize, () =>
    knex('auditEvents')
      .whereIn(
        'id',
        knex('auditEvents').select('id').where('occurredAt', '<', olderThanDays(knex, auditDays)).limit(batchSize)
      )
      .delete()
  )

  // Counted from the expiry of the session's token family, whether it ran
  // out or was revoked earlier. Its refresh tokens go with it.
  const sessions = await inBatches(batchSize, () =>
    knex.transaction(async (trx): Promise<number> => {
      const ids = await trx<{ id: string }>('authSessions')
        .where('familyExpiresAt', '<', olderThanDays(trx, sessionDays))
        .limit(batchSize)
        .forUpdate()
        .skipLocked()
        .pluck('id')
      if (ids.length === 0) return 0
      await trx('authRefreshTokens').whereIn('sessionId', ids).delete()
      return trx('authSessions').whereIn('id', ids).delete()
    })
  )

  return { auditEvents, sessions }
}
