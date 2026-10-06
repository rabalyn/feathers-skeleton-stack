import { describe, expect, it } from 'vitest'
import { BUCKET_ENTRIES, TABLE_ENTRIES } from '../../src/gdpr/registry.js'
import { PRODUCTION_BUCKETS } from '../../src/storage.js'
import { db } from '../support/worker-database.js'

// ADR 0013: the personal data registry names every store holding personal
// data. Checked against the migrated schema, so a new table referencing a
// user cannot be added without deciding its place in export and erasure.

describe('personal data registry', () => {
  it('lists every column that references users, and no other', async () => {
    const { rows } = await db().raw<{ rows: { table: string; column: string }[] }>(`
      SELECT c.conrelid::regclass::text AS table, a.attname AS column
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       WHERE c.contype = 'f' AND c.confrelid = 'users'::regclass
    `)
    const inSchema = rows.map(({ table, column }) => `${table}.${column}`).sort()
    const inRegistry = TABLE_ENTRIES.flatMap((entry) => entry.userColumns.map((column) => `${entry.table}.${column}`)).sort()
    expect(inRegistry).toEqual(inSchema)
  })

  it('names tables that exist, once each', async () => {
    const names = TABLE_ENTRIES.map((entry) => entry.table)
    expect(new Set(names).size).toBe(names.length)
    const existing = await db()('pg_tables').where({ schemaname: 'public' }).pluck('tablename')
    expect(existing).toEqual(expect.arrayContaining(names))
  })

  // The skeleton's tables in erase_user(), the product's in the hook it
  // calls (ADR 0035); either function may name a table.
  const functionBody = async (signature: string) => {
    const { rows } = await db().raw<{ rows: { body: string }[] }>(`SELECT pg_get_functiondef(?::regprocedure) AS body`, [signature])
    return rows[0]!.body
  }

  it('has erase_user() call the product hook', async () => {
    expect(await functionBody('erase_user(uuid, timestamptz)')).toMatch(/PERFORM erase_user_product\(p_user_id, p_erased_at\)/)
  })

  it('has erase_user() or erase_user_product() handle every table whose erasure is not keep', async () => {
    const body = (await functionBody('erase_user(uuid, timestamptz)')) + (await functionBody('erase_user_product(uuid, timestamptz)'))
    for (const entry of TABLE_ENTRIES.filter((table) => table.erasure !== 'keep')) {
      expect(body, entry.table).toMatch(new RegExp(`\\b${entry.table}\\b`))
    }
  })

  it('covers every production bucket', () => {
    expect(BUCKET_ENTRIES.map((entry) => entry.bucket).sort()).toEqual([...PRODUCTION_BUCKETS].sort())
  })
})
