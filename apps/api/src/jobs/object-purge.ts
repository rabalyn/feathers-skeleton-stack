import type { Knex } from 'knex'
import type { SettingsStore } from '../settings/store.js'
import type { Storage } from '../storage.js'

// Object purge (ADR 0020, 0024), daily:
//
//   - soft-deleted files past the purge delay lose their object, then their
//     row. The delay outlasts backup retention (ADR 0025), so no database a
//     backup could restore still references a purged object (ADR 0017);
//   - stored files nobody attached within a day are soft-deleted, so an
//     abandoned upload stops counting against its owner's quota;
//   - pending rows older than an hour are uploads that never finished (the
//     api went away mid-stream): their partial object and row are removed;
//   - objects older than a day without any row are removed. A row is always
//     written before its object, so this only finds what a failure left
//     behind, or objects of a database that no longer has them (a restore
//     to an earlier state): nothing can reference them.
//
// The object goes first: a row without its object would be served as a
// 404 and logged, an object without its row would be orphaned for good.

export const PURGE_BATCH_SIZE = 100
export const UNATTACHED_GRACE_HOURS = 24
export const PENDING_GRACE_HOURS = 1
export const ORPHAN_GRACE_HOURS = 24

export interface PurgeResult {
  purged: number
  abandoned: number
  unfinished: number
  orphans: number
}

export interface PurgeOptions {
  batchSize?: number
  orphanGraceHours?: number
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// Objects without a row, older than the grace period; checked a listing
// page at a time.
const removeOrphans = async (knex: Knex, storage: Storage, graceHours: number): Promise<number> => {
  const cutoff = Date.now() - graceHours * 3600_000
  let removed = 0
  for await (const page of storage.list()) {
    const old = page.filter((object) => object.lastModified.getTime() < cutoff).map((object) => object.key)
    const ids = old.filter((key) => UUID.test(key))
    const known = new Set(ids.length ? await knex('files').whereIn('id', ids).pluck<string[]>('id') : [])
    const orphans = old.filter((key) => !known.has(key))
    await storage.deleteMany(orphans)
    removed += orphans.length
  }
  return removed
}

const hoursAgo = (knex: Knex, hours: number) => knex.raw('now() - make_interval(hours => ?)', [hours])
const daysAgo = (knex: Knex, days: number) => knex.raw('now() - make_interval(days => ?)', [days])

// Deletes object and row of each file the query selects, a batch at a time.
// Rows are locked and skipped when locked, so two workers never purge the
// same file.
const removeFiles = async (
  knex: Knex,
  storage: Storage,
  select: (query: Knex.QueryBuilder) => Knex.QueryBuilder,
  batchSize: number
): Promise<number> => {
  let total = 0
  for (;;) {
    const removed = await knex.transaction(async (trx): Promise<number> => {
      const ids = await select(trx('files'))
        .limit(batchSize)
        .forUpdate()
        .skipLocked()
        .pluck<string[]>('id')
      for (const id of ids) await storage.delete(id)
      if (ids.length) await trx('files').whereIn('id', ids).delete()
      return ids.length
    })
    total += removed
    if (removed < batchSize) return total
  }
}

export const objectPurge = async (
  knex: Knex,
  settings: SettingsStore,
  storage: Storage,
  { batchSize = PURGE_BATCH_SIZE, orphanGraceHours = ORPHAN_GRACE_HOURS }: PurgeOptions = {}
): Promise<PurgeResult> => {
  const purgeDelayDays = await settings.get('objectPurgeDelayDays')

  const abandoned = await knex('files')
    .where({ state: 'stored' })
    .whereNull('attachedAt')
    .whereNull('deletedAt')
    .where('createdAt', '<', hoursAgo(knex, UNATTACHED_GRACE_HOURS))
    .update({ deletedAt: knex.fn.now() })

  const purged = await removeFiles(
    knex,
    storage,
    (files) => files.whereNotNull('deletedAt').where('deletedAt', '<', daysAgo(knex, purgeDelayDays)),
    batchSize
  )

  const unfinished = await removeFiles(
    knex,
    storage,
    (files) => files.where({ state: 'pending' }).where('createdAt', '<', hoursAgo(knex, PENDING_GRACE_HOURS)),
    batchSize
  )

  const orphans = await removeOrphans(knex, storage, orphanGraceHours)

  return { purged, abandoned, unfinished, orphans }
}
