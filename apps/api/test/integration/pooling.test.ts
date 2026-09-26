import type { Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createKnex } from '../../src/db.js'
import { TEMPLATE, assertDatabaseName, loadTestDatabaseConfig, maintenanceKnex } from '../support/database.js'

// ADR 0004 / 0015: parallel workers, each on a database of its own, queue
// at PgBouncer once together they want more than the test user's cap,
// instead of exhausting PostgreSQL. Four databases with 20 concurrent
// transactions each want 80 connections against a cap of 60; each stays
// below the per-database pool of 25, so the cap is the only limit reached.

const WORKERS = 4
const POOL = 20
const USER_CAP = 60
const names = Array.from({ length: WORKERS }, (_, i) => assertDatabaseName(`test_w${9001 + i}`))

let admin: Knex
const pools: Knex[] = []

// Every DROP DATABASE waits for a checkpoint; concurrent drops share one.
const ADMIN_POOL = WORKERS

beforeAll(async () => {
  const config = await loadTestDatabaseConfig()
  admin = await maintenanceKnex(ADMIN_POOL)
  await Promise.all(
    names.map(async (name) => {
      await admin.raw(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      await admin.raw(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE}`)
    })
  )
  for (const name of names) pools.push(createKnex({ ...config, databaseName: name, databasePoolMax: POOL }))
}, 60_000)

// The databases stay, like every worker's: dropping one now waits for a
// checkpoint of all the suite has written. The next run's global setup, or
// this file's beforeAll, drops them.
afterAll(async () => {
  await Promise.all(pools.map((p) => p.destroy()))
  await admin.destroy()
})

describe('parallel test workers', () => {
  it('queue at PgBouncer instead of exceeding the server connection cap', async () => {
    let peak = 0
    let sampling = true
    const sampler = (async () => {
      while (sampling) {
        const { rows } = await admin.raw<{ rows: { n: number }[] }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = current_user`
        )
        peak = Math.max(peak, rows[0]?.n ?? 0)
        await new Promise((r) => setTimeout(r, 20))
      }
    })()

    const work = pools.flatMap((pool) =>
      Array.from({ length: POOL }, () =>
        pool.transaction(async (trx) => {
          await trx.raw('SELECT pg_sleep(0.3)')
          return true
        })
      )
    )
    const results = await Promise.allSettled(work)
    sampling = false
    await sampler

    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(failures, String(failures.map((f) => f.reason))).toHaveLength(0)
    expect(results).toHaveLength(WORKERS * POOL)
    // More transactions than the cap ran, so the cap was actually reached.
    expect(peak).toBeGreaterThan(USER_CAP / 2)
    expect(peak).toBeLessThanOrEqual(USER_CAP)
  }, 60_000)
})
