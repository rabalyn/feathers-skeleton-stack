import type { Knex } from 'knex'
import { S3_KEYS, loadConfig } from '../../src/config.js'
import { Storage } from '../../src/storage.js'
import { WORKER_PREFIX, assertDatabaseName, maintenanceKnex } from './database.js'

// The object purge tests' own bucket: its orphan sweep sees every object in
// it, so no other test file may write there (object-purge.test.ts).
export const PURGE_TEST_BUCKET = 'test-purge'
// Likewise the data export tests' exports bucket, for the export expiry's
// orphan sweep (data-exports.test.ts).
export const DATA_EXPORTS_TEST_BUCKET = 'test-data-exports'

// Every DROP DATABASE waits for a checkpoint. Right after a run, with every
// worker database freshly written, one checkpoint has taken over a minute on
// a busy disk, while the other drops queue for the pool past knex's default
// 60 s to acquire a connection. They wait as long as the checkpoints take:
// the run has passed or failed by now, and a timeout here only leaves the
// databases to the next run, making its cleanup slower still.
const DROP_ACQUIRE_TIMEOUT_MS = 10 * 60_000

// DROP DATABASE ... WITH (FORCE) refuses (42501) when a backend in the
// database has no role yet: an autovacuum worker, or a connection still
// authenticating. PostgreSQL 18's permission check compares the caller with
// that missing role, whatever pg_signal_autovacuum_worker grants. Such a
// backend lives for a fraction of a second; the drop is tried again.
const DROP_ATTEMPTS = 5
const DROP_RETRY_MS = 1000

const dropDatabase = async (knex: Knex, name: string) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await knex.raw(`DROP DATABASE IF EXISTS ${assertDatabaseName(name)} WITH (FORCE)`)
    } catch (error) {
      if ((error as { code?: string }).code !== '42501' || attempt === DROP_ATTEMPTS) throw error
      await new Promise((resolve) => setTimeout(resolve, DROP_RETRY_MS))
    }
  }
}

// A crashed run must not leak state into the next one (ADR 0015).
const dropWorkerDatabases = async () => {
  const knex = await maintenanceKnex(8, { acquireConnectionTimeout: DROP_ACQUIRE_TIMEOUT_MS })
  try {
    const { rows } = await knex.raw<{ rows: { datname: string }[] }>(
      `SELECT datname FROM pg_database WHERE datname LIKE ? AND datdba = (SELECT oid FROM pg_roles WHERE rolname = current_user)`,
      [`${WORKER_PREFIX}%`]
    )
    // Every DROP DATABASE waits for a checkpoint; concurrent drops share one.
    await Promise.all(rows.map(({ datname }) => dropDatabase(knex, datname)))
  } finally {
    await knex.destroy()
  }
}

// The objects of the tests' buckets go with their databases (ADR 0020), at
// the start of a run and at its end.
const emptyTestBuckets = async () => {
  const config = await loadConfig(S3_KEYS)
  for (const bucket of [config.s3UploadsBucket, config.s3ExportsBucket, PURGE_TEST_BUCKET, DATA_EXPORTS_TEST_BUCKET]) {
    const storage = new Storage(config, bucket)
    try {
      await storage.empty()
    } finally {
      storage.close()
    }
  }
}

// Worker databases go at the start of a run and at its end, in one go:
// every DROP DATABASE waits for a checkpoint.
export default async function setup() {
  await Promise.all([dropWorkerDatabases(), emptyTestBuckets()])
  return async () => {
    await Promise.all([dropWorkerDatabases(), emptyTestBuckets()])
  }
}
