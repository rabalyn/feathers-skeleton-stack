import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Application } from '../../src/app.js'
import { objectPurge } from '../../src/jobs/object-purge.js'
import type { User } from '../../src/services/users/users.schema.js'
import { createTestApp } from '../support/app.js'
import { PURGE_TEST_BUCKET } from '../support/global-setup.js'
import { db } from '../support/worker-database.js'

// ADR 0020, 0024: what the daily object purge removes, and what it leaves
// alone, against the stack's Garage, in a bucket no other test file uses:
// the orphan sweep would take their objects for its own.

let app: Application
let owner: User

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3600_000)
const BODY = Buffer.from('%PDF-1.4 purge test')

// A files row as the given state would leave it, with its object stored.
const file = async (row: { state?: 'pending' | 'stored'; created_at?: Date; attached_at?: Date | null; deleted_at?: Date | null }) => {
  const [inserted] = await db()('files')
    .insert({
      owner_id: owner.id,
      filename: 'f.pdf',
      content_type: 'application/pdf',
      size_bytes: BODY.length,
      sha256: row.state === 'pending' ? null : 'a'.repeat(64),
      state: 'stored',
      ...row
    })
    .returning<{ id: string }[]>('id')
  await app.get('storage').put(inserted!.id, Readable.from(BODY), BODY.length, 'application/pdf')
  return inserted!.id
}

const exists = async (id: string) => ({
  row: Boolean(await db()('files').where({ id }).first()),
  object: Boolean(await app.get('storage').get(id))
})

beforeAll(async () => {
  ;({ app } = await createTestApp({ s3: { s3UploadsBucket: PURGE_TEST_BUCKET } }))
  owner = await app.service('users').create({ tuId: 'pu01purg', authSource: 'saml', givenName: 'p', surname: 'p', email: null })
})

afterAll(async () => {
  await app.teardown()
})

describe('object purge', () => {
  it('removes object and row of files soft-deleted longer ago than the purge delay, and nothing younger', async () => {
    const delay = await app.get('settings').get('objectPurgeDelayDays')
    const old = await file({ attached_at: hoursAgo(24 * (delay + 2)), deleted_at: hoursAgo(24 * (delay + 1)) })
    const recent = await file({ attached_at: hoursAgo(48), deleted_at: hoursAgo(24 * (delay - 1)) })
    await objectPurge(app.get('knex'), app.get('settings'), app.get('storage'))
    expect(await exists(old)).toEqual({ row: false, object: false })
    expect(await exists(recent)).toEqual({ row: true, object: true })
  })

  it('soft-deletes stored files nobody attached within a day, and leaves attached ones', async () => {
    const abandoned = await file({ created_at: hoursAgo(25) })
    const fresh = await file({ created_at: hoursAgo(1) })
    const attached = await file({ created_at: hoursAgo(25), attached_at: hoursAgo(24) })
    await objectPurge(app.get('knex'), app.get('settings'), app.get('storage'))
    expect(await db()('files').where({ id: abandoned }).first()).toMatchObject({ deleted_at: expect.any(Date) })
    expect(await db()('files').where({ id: fresh }).first()).toMatchObject({ deleted_at: null })
    expect(await db()('files').where({ id: attached }).first()).toMatchObject({ deleted_at: null })
    // Soft-deleted only: the object stays for the purge delay.
    expect(await exists(abandoned)).toEqual({ row: true, object: true })
  })

  it('removes uploads that never finished, after an hour', async () => {
    const unfinished = await file({ state: 'pending', created_at: hoursAgo(2) })
    const inFlight = await file({ state: 'pending', created_at: new Date() })
    const result = await objectPurge(app.get('knex'), app.get('settings'), app.get('storage'))
    expect(result.unfinished).toBeGreaterThanOrEqual(1)
    expect(await exists(unfinished)).toEqual({ row: false, object: false })
    expect(await exists(inFlight)).toEqual({ row: true, object: true })
  })

  it('removes objects that have no row once they are old enough, and keeps those that have one', async () => {
    const orphan = '01a0d950-4ccc-71d2-bc85-40a1a963e526'
    await app.get('storage').put(orphan, Readable.from(BODY), BODY.length, 'application/pdf')
    const stray = 'not-a-file-id'
    await app.get('storage').put(stray, Readable.from(BODY), BODY.length, 'application/pdf')
    const kept = await file({ attached_at: new Date() })
    // Young orphans are left: their row may be on its way.
    expect((await objectPurge(app.get('knex'), app.get('settings'), app.get('storage'))).orphans).toBe(0)
    expect(await app.get('storage').get(orphan)).toBeDefined()

    const result = await objectPurge(app.get('knex'), app.get('settings'), app.get('storage'), { orphanGraceHours: 0 })
    expect(result.orphans).toBe(2)
    expect(await app.get('storage').get(orphan)).toBeUndefined()
    expect(await app.get('storage').get(stray)).toBeUndefined()
    expect(await exists(kept)).toEqual({ row: true, object: true })
  })

  it('works through more files than one batch', async () => {
    const delay = await app.get('settings').get('objectPurgeDelayDays')
    const ids = await Promise.all(
      Array.from({ length: 5 }, () => file({ attached_at: hoursAgo(24 * (delay + 2)), deleted_at: hoursAgo(24 * (delay + 1)) }))
    )
    await objectPurge(app.get('knex'), app.get('settings'), app.get('storage'), { batchSize: 2 })
    for (const id of ids) expect(await exists(id)).toEqual({ row: false, object: false })
  })
})
