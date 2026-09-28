import type { Knex } from 'knex'
import { afterAll, beforeAll } from 'vitest'
import type { DatabaseConfig } from '../../src/config.js'
import { createKnex } from '../../src/db.js'
import {
  TEMPLATE,
  assertDatabaseName,
  loadTestDatabaseConfig,
  maintenanceKnex,
  workerDatabaseName
} from './database.js'

// Every test file starts from a fresh clone of test_template, under a name
// of its own. Cloning takes milliseconds and needs no migration run; the
// clones are dropped by global setup, never during the run (ADR 0015).

let current: Knex | undefined
let currentConfig: DatabaseConfig | undefined

// Knex in database names, for tests of the data tier itself.
export const db = (): Knex => {
  if (!current) throw new Error('worker database is not ready')
  return current
}

// Connection settings of this worker's database, for building an app.
export const workerDatabaseConfig = (): DatabaseConfig => {
  if (!currentConfig) throw new Error('worker database is not ready')
  return currentConfig
}

beforeAll(async () => {
  const name = assertDatabaseName(workerDatabaseName())
  const admin = await maintenanceKnex()
  try {
    await admin.raw(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE}`)
  } finally {
    await admin.destroy()
  }
  currentConfig = { ...(await loadTestDatabaseConfig()), databaseName: name }
  current = createKnex(currentConfig)
})

afterAll(async () => {
  await current?.destroy()
  current = undefined
  currentConfig = undefined
})
