import type { Knex } from 'knex'
import type { SettingsStore } from '../settings/store.js'
import type { Storage } from '../storage.js'

// Export expiry (ADR 0013, 0024), daily, on the exports bucket:
//
//   - exports older than exportRetentionDays lose their object, then their
//     row, ready and failed alike;
//   - an export still pending after a day lost its job (Valkey restored to
//     an earlier state, say) and is marked failed, so its subject can ask
//     again;
//   - objects without a row, older than an hour, are removed: what erasure
//     left behind (erase_user() deletes the rows), or an upload whose row
//     went away. A row is always written before its object.

export const EXPORT_BATCH_SIZE = 100
export const STALLED_EXPORT_HOURS = 24
export const ORPHAN_EXPORT_GRACE_HOURS = 1

export interface ExportExpiryResult {
  expired: number
  stalled: number
  orphans: number
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export interface ExportExpiryOptions {
  batchSize?: number
  orphanGraceHours?: number
}

export const exportExpiry = async (
  knex: Knex,
  settings: SettingsStore,
  exports: Storage,
  { batchSize = EXPORT_BATCH_SIZE, orphanGraceHours = ORPHAN_EXPORT_GRACE_HOURS }: ExportExpiryOptions = {}
): Promise<ExportExpiryResult> => {
  const retentionDays = await settings.get('exportRetentionDays')

  let expired = 0
  for (;;) {
    const removed = await knex.transaction(async (trx): Promise<number> => {
      const ids = await trx('dataExports')
        .where('createdAt', '<', trx.raw('now() - make_interval(days => ?)', [retentionDays]))
        .limit(batchSize)
        .forUpdate()
        .skipLocked()
        .pluck<string[]>('id')
      // The object first: a row without its object is a 404 to its
      // requester, an object without its row would be kept for good.
      await exports.deleteMany(ids)
      if (ids.length) await trx('dataExports').whereIn('id', ids).delete()
      return ids.length
    })
    expired += removed
    if (removed < batchSize) break
  }

  const stalled = await knex('dataExports')
    .where({ state: 'pending' })
    .where('createdAt', '<', knex.raw('now() - make_interval(hours => ?)', [STALLED_EXPORT_HOURS]))
    .update({ state: 'failed', completedAt: knex.fn.now() })

  const cutoff = Date.now() - orphanGraceHours * 3600_000
  let orphans = 0
  for await (const page of exports.list()) {
    const old = page.filter((object) => object.lastModified.getTime() < cutoff).map((object) => object.key)
    const ids = old.filter((key) => UUID.test(key))
    const known = new Set(ids.length ? await knex('dataExports').whereIn('id', ids).pluck<string[]>('id') : [])
    const unknown = old.filter((key) => !known.has(key))
    await exports.deleteMany(unknown)
    orphans += unknown.length
  }

  return { expired, stalled, orphans }
}
