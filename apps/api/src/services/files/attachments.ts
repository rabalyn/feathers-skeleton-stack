import { BadRequest } from '@feathersjs/errors'
import type { Knex } from 'knex'
import { PRODUCT_FILE_REFERENCES } from '../../product/files.js'

// What references a file (a document, an avatar) attaches it, and releases
// it by soft deletion when the reference goes (ADR 0020). A file that is
// never attached is soft-deleted by the purge job, so an abandoned upload
// does not hold its owner's quota for long.

export interface AttachOptions {
  // The caller attaches only what they uploaded themselves.
  ownerId: string
  allowedTypes: readonly string[]
}

// Marks a stored, unattached file of `ownerId` as attached; anything else is
// a 400, worded the same whether the file is someone else's or missing, so
// the answer confirms nothing about other people's files.
export const attachFile = async (knex: Knex, fileId: string, { ownerId, allowedTypes }: AttachOptions) => {
  const updated = await knex('files')
    .where({ id: fileId, ownerId, state: 'stored' })
    .whereNull('attachedAt')
    .whereNull('deletedAt')
    .whereIn('contentType', allowedTypes as string[])
    .update({ attachedAt: knex.fn.now() })
  if (updated !== 1) throw new BadRequest('No such file to attach', { fileId })
}

export const releaseFile = async (knex: Knex, fileId: string) => {
  await knex('files').where({ id: fileId }).whereNull('deletedAt').update({ deletedAt: knex.fn.now() })
}

// A record that attaches files (ADR 0020): whoever may read the record may
// read the bytes of its file. Avatars are not listed: they are shown inline
// and checked apart, in files.ts.
export interface FileReference {
  // The table and the column holding the file's id, as the camelCase Knex
  // names them: `documents`, `fileId`.
  table: string
  column: string
  // The service whose read rule is asked about the record (ADR 0011).
  subject: string
}

// The skeleton's, and the product's from product/files.ts (ADR 0035).
export const FILE_REFERENCES: readonly FileReference[] = [
  { table: 'documents', column: 'fileId', subject: 'documents' },
  ...PRODUCT_FILE_REFERENCES
]
