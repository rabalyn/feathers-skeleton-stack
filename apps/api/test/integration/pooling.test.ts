import type { Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createKnex } from '../../src/db.js'
import { TEMPLATE, assertDatabaseName, loadTestDatabaseConfig, maintenanceKnex } from '../support/database.js'

// ADR 0004 / 0015: a 48-worker run, each worker with a pool of two, queues
// at PgBouncer instead of exhausting PostgreSQL. Simulated here with 48
// databases and 96 concurrent transactions.

const WORKERS = 48
const POOL = 2
const USER_CAP = 60
const names = Array.from({ length: WORKERS }, (_, i) => assertDatabaseName(`test_w${9001 + i}`))

let admin: Knex
const pools: Knex[] = []

beforeAll(async () => {
  admin = await maintenanceKnex()
  for (const name of names) {
    await admin.raw(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    await admin.raw(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE}`)
  }
  const config = await loadTestDatabaseConfig()
  for (const name of names) pools.push(createKnex({ ...config, databaseName: name, databasePoolMax: POOL }))
}, 60_000)

afterAll(async () => {
  await Promise.all(pools.map((p) => p.destroy()))
  for (const name of names) await admin.raw(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
  await admin.destroy()
}, 60_000)

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

    const failures = results.filter((r) => r.status === 'rejected')
    expect(failures, String(failures.map((f) => (f as PromiseRejectedResult).reason))).toHaveLength(0)
    expect(results).toHaveLength(WORKERS * POOL)
    // More transactions than the cap ran, so the cap was actually reached.
    expect(peak).toBeGreaterThan(USER_CAP / 2)
    expect(peak).toBeLessThanOrEqual(USER_CAP)
  }, 60_000)
})
