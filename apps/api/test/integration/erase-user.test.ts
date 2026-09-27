import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Application } from '../../src/app.js'
import { createTestApp } from '../support/app.js'

// ADR 0013: erase_user(), the erasure the api and a restore both apply.

let app: Application
const knex = () => app.get('knex')

beforeAll(async () => {
  ;({ app } = await createTestApp())
})

afterAll(async () => {
  await app.teardown()
})

const person = async (tuId: string) => {
  const user = await app
    .service('users')
    .create({ tuId, givenName: 'Erika', surname: 'Muster', email: `${tuId}@example.test`, authSource: 'saml' })
  const [avatar, attachment, loose] = await knex()('files')
    .insert(
      ['a.png', 'd.pdf', 'x.pdf'].map((filename) => ({
        ownerId: user.id,
        filename,
        contentType: filename.endsWith('.png') ? 'image/png' : 'application/pdf',
        sizeBytes: 10,
        sha256: 'a'.repeat(64),
        state: 'stored',
        attachedAt: new Date()
      }))
    )
    .returning('id')
  await knex()('users').where({ id: user.id }).update({ avatarFileId: (avatar as { id: string }).id })
  await knex()('documents').insert({ ownerId: user.id, title: 'Doc', fileId: (attachment as { id: string }).id })
  const [session] = await knex()('authSessions')
    .insert({ userId: user.id, idleExpiresAt: new Date(Date.now() + 3600_000), familyExpiresAt: new Date(Date.now() + 3600_000), userAgent: 'UA' })
    .returning('id')
  await knex()('authRefreshTokens').insert({ sessionId: (session as { id: string }).id, tokenHash: Buffer.from(tuId) })
  await knex()('dataExports').insert({ subjectId: user.id, requestedBy: user.id })
  await knex()('auditEvents').insert({ actorId: user.id, action: 'login', resourceType: 'users', resourceId: user.id })
  return { id: user.id, files: [avatar, attachment, loose].map((row) => (row as { id: string }).id) }
}

const erase = async (id: string, at?: Date) => {
  const { rows } = await knex().raw<{ rows: { erased: boolean }[] }>(
    at ? 'SELECT erase_user(?, ?) AS erased' : 'SELECT erase_user(?) AS erased',
    at ? [id, at] : [id]
  )
  return rows[0]!.erased
}

describe('erase_user()', () => {
  it('clears identifiers, removes sessions, documents and exports, soft-deletes files and logs the id', async () => {
    const { id, files } = await person('er01eras')
    const other = await person('er02keep')

    expect(await erase(id)).toBe(true)

    const user = await knex()('users').where({ id }).first()
    expect(user).toMatchObject({ tuId: null, givenName: null, surname: null, email: null, avatarFileId: null, enabled: false })
    expect(user.erasedAt).toBeInstanceOf(Date)
    expect(await knex()('authSessions').where({ userId: id })).toEqual([])
    expect(await knex()('documents').where({ ownerId: id })).toEqual([])
    expect(await knex()('dataExports').where({ subjectId: id })).toEqual([])
    expect(await knex()('files').whereIn('id', files).whereNull('deletedAt')).toEqual([])
    // Kept, pseudonymous.
    expect(await knex()('auditEvents').where({ actorId: id }).count({ n: '*' })).toEqual([{ n: '1' }])
    expect(await knex()('erasures').where({ userId: id }).first()).toMatchObject({ userId: id })

    // Nobody else is touched.
    expect(await knex()('users').where({ id: other.id }).first()).toMatchObject({ tuId: 'er02keep', enabled: true })
    expect(await knex()('authSessions').where({ userId: other.id })).toHaveLength(1)
    expect(await knex()('files').whereIn('id', other.files).whereNull('deletedAt')).toHaveLength(3)
  })

  it('is idempotent and keeps the first erasure time', async () => {
    const { id } = await person('er03twic')
    const first = new Date('2026-01-02T03:04:05Z')
    await erase(id, first)
    expect(await erase(id)).toBe(true)
    expect((await knex()('users').where({ id }).first()).erasedAt).toEqual(first)
    expect((await knex()('erasures').where({ userId: id }).first()).erasedAt).toEqual(first)
  })

  it('does nothing for an id no user has', async () => {
    expect(await erase('01900000-0000-7000-8000-000000000000')).toBe(false)
    expect(await knex()('erasures').where({ userId: '01900000-0000-7000-8000-000000000000' })).toEqual([])
  })
})
