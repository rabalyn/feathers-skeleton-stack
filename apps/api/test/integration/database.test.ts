import { describe, expect, it } from 'vitest'
import { db } from '../support/worker-database.js'

// The data tier as ADR 0003, 0004, 0009 and 0015 describe it, seen from a
// pooled test connection.

describe('database access through PgBouncer', () => {
  it('is connected to this worker’s own database', async () => {
    const { rows } = await db().raw<{ rows: { name: string }[] }>('SELECT current_database() AS name')
    expect(rows[0]?.name).toMatch(/^test_w\d+_[0-9a-f]{8}$/)
  })

  it('has the migrated schema, but not the migration bookkeeping', async () => {
    const { rows } = await db().raw<{ rows: { users: string | null }[] }>(
      `SELECT to_regclass('public.users')::text AS users`
    )
    expect(rows[0]?.users).toBe('users')
    // knex_migrations predates the default privileges; the application
    // has no business reading it.
    await expect(db().raw('SELECT 1 FROM knex_migrations')).rejects.toThrow(/permission denied/)
  })

  // Contract step of refresh rotation (ADR 0003): the tokens live in
  // auth_refresh_tokens only.
  it('keeps no refresh token state on auth_sessions', async () => {
    const { rows } = await db().raw<{ rows: { name: string }[] }>(
      `SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'auth_sessions'`
    )
    const columns = rows.map((row) => row.name)
    expect(columns).toContain('family_expires_at')
    expect(columns).not.toEqual(expect.arrayContaining(['refresh_token_hash']))
    expect(columns).not.toEqual(expect.arrayContaining(['rotated_at']))
    expect(columns).not.toEqual(expect.arrayContaining(['family_id']))
  })

  it('generates UUIDv7 surrogate keys', async () => {
    const [row] = await db()('users')
      .insert({ tu_id: 'ab12cdef', auth_source: 'saml' })
      .returning(['id'])
    expect(row?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('rolls back a failed transaction as a unit', async () => {
    await expect(
      db().transaction(async (trx) => {
        await trx('users').insert({ tu_id: 'rollback1', auth_source: 'saml' })
        await trx('users').insert({ tu_id: 'rollback1', auth_source: 'saml' })
      })
    ).rejects.toThrow(/unique/)
    expect(await db()('users').where({ tu_id: 'rollback1' })).toHaveLength(0)
  })

  it('refuses a TU-ID on the local account', async () => {
    await expect(db()('users').insert({ tu_id: 'x1', auth_source: 'local' })).rejects.toThrow(
      /users_local_has_no_tu_id/
    )
  })

  it('treats email as unique regardless of case', async () => {
    await db()('users').insert({ tu_id: 'mail1', auth_source: 'saml', email: 'A@example.org' })
    await expect(
      db()('users').insert({ tu_id: 'mail2', auth_source: 'saml', email: 'a@example.org' })
    ).rejects.toThrow(/users_email_key/)
  })

  it('grants the application roles DML but not DDL', async () => {
    await expect(db().raw('CREATE TABLE sneaky (id int)')).rejects.toThrow(/permission denied/)
    await expect(db().raw('ALTER TABLE users ADD COLUMN sneaky int')).rejects.toThrow(/must be owner/)
  })

  it('reaches PostgreSQL over TLS behind PgBouncer', async () => {
    const { rows } = await db().raw<{ rows: { ssl: boolean }[] }>(
      'SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()'
    )
    expect(rows[0]?.ssl).toBe(true)
  })
})
