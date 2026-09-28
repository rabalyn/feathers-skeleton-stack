import { BadRequest } from '@feathersjs/errors'
import type { Knex } from 'knex'

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
