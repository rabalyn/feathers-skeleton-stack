import { randomBytes } from 'node:crypto'
import type { Knex } from 'knex'
import { DATABASE_KEYS, loadConfig } from '../../src/config.js'
import { createKnex } from '../../src/db.js'

// Per-worker databases (ADR 0015): test_w<N> cloned from test_template, all
// through PgBouncer's wildcard entry, as the `test` role.

export const TEMPLATE = 'test_template'
export const WORKER_PREFIX = 'test_w'

export const loadTestDatabaseConfig = () => loadConfig(DATABASE_KEYS)

// The maintenance connection used to create and drop worker databases.
export const maintenanceKnex = async (poolMax = 1, overrides?: Partial<Knex.Config>): Promise<Knex> =>
  createKnex({ ...(await loadTestDatabaseConfig()), databaseName: 'postgres', databasePoolMax: poolMax }, { overrides })

// A new name for every test file: dropping a database waits for a
// checkpoint, which with every worker writing can outlast the hook timeout,
// so no database is dropped during a run. Global setup drops them all, once
// before the run and once after it (ADR 0015).
export const workerDatabaseName = (): string => {
  const id = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID
  if (!id || !/^\d+$/.test(id)) throw new Error('not running inside a Vitest worker')
  return `${WORKER_PREFIX}${id}_${randomBytes(4).toString('hex')}`
}

// Database names cannot be bound as parameters; these are generated above
// and checked here before being interpolated.
export const assertDatabaseName = (name: string) => {
  if (!/^test_(w\d+(_[0-9a-f]{8})?|template)$/.test(name)) throw new Error(`refusing database name ${name}`)
  return name
}
