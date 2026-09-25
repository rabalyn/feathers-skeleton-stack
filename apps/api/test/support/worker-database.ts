import type { Knex } from 'knex'
import { afterAll, beforeAll } from 'vitest'
import { createKnex } from '../../src/db.js'
import {
  TEMPLATE,
  assertDatabaseName,
  loadTestDatabaseConfig,
  maintenanceKnex,
  workerDatabaseName
} from './database.js'

// Every test file starts from a fresh clone of test_template. Cloning takes
// milliseconds and needs no migration run (ADR 0015).

let current: Knex | undefined

export const db = (): Knex => {
  if (!current) throw new Error('worker database is not ready')
  return current
}

beforeAll(async () => {
  const name = assertDatabaseName(workerDatabaseName())
  const admin = await maintenanceKnex()
  try {
    await admin.raw(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    await admin.raw(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE}`)
  } finally {
    await admin.destroy()
  }
  const config = await loadTestDatabaseConfig()
  current = createKnex({ ...config, databaseName: name })
})

afterAll(async () => {
  await current?.destroy()
  current = undefined
})
