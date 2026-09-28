import { S3_KEYS, loadConfig } from '../../src/config.js'
import { Storage } from '../../src/storage.js'
import { WORKER_PREFIX, assertDatabaseName, maintenanceKnex } from './database.js'

// The object purge tests' own bucket: its orphan sweep sees every object in
// it, so no other test file may write there (object-purge.test.ts).
export const PURGE_TEST_BUCKET = 'test-purge'

// A crashed run must not leak state into the next one (ADR 0015).
const dropWorkerDatabases = async () => {
  const knex = await maintenanceKnex(8)
  try {
    const { rows } = await knex.raw<{ rows: { datname: string }[] }>(
      `SELECT datname FROM pg_database WHERE datname LIKE ? AND datdba = (SELECT oid FROM pg_roles WHERE rolname = current_user)`,
      [`${WORKER_PREFIX}%`]
    )
    // Every DROP DATABASE waits for a checkpoint; concurrent drops share one.
    await Promise.all(
      rows.map(({ datname }) => knex.raw(`DROP DATABASE IF EXISTS ${assertDatabaseName(datname)} WITH (FORCE)`))
    )
  } finally {
    await knex.destroy()
  }
}

// The objects of the tests' buckets go with their databases (ADR 0020), at
// the start of a run and at its end.
const emptyTestBuckets = async () => {
  const config = await loadConfig(S3_KEYS)
  for (const bucket of [config.s3UploadsBucket, config.s3ExportsBucket, PURGE_TEST_BUCKET]) {
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
