import { describe, expect, it } from 'vitest'
import { FILE_REFERENCES } from '../../src/services/files/attachments.js'
import { db } from '../support/worker-database.js'

// ADR 0020, 0035: every column referencing files(id) is a record whose
// readers may download the file, listed in FILE_REFERENCES (the product's in
// product/files.ts), or the avatar, which files.ts checks apart. So a
// product's new attachment cannot leave its files unreadable, nor a listed
// one point at the wrong column.
const snake = (name: string) => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)

describe('file references', () => {
  it('lists every column that references files, besides the avatar, and no other', async () => {
    const { rows } = await db().raw<{ rows: { table: string; column: string }[] }>(`
      SELECT c.conrelid::regclass::text AS table, a.attname AS column
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       WHERE c.contype = 'f' AND c.confrelid = 'files'::regclass
    `)
    const inSchema = rows.map(({ table, column }) => `${table}.${column}`).filter((name) => name !== 'users.avatar_file_id')
    const listed = FILE_REFERENCES.map((reference) => `${snake(reference.table)}.${snake(reference.column)}`)
    expect(listed.sort()).toEqual(inSchema.sort())
  })
})
