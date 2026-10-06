import { BadRequest, Conflict, Unavailable } from '@feathersjs/errors'
import type { Knex } from 'knex'
import type { Application } from './app.js'
import { recordAudit } from './audit.js'
import { DirectoryUnavailable } from './directory.js'
import { assignDefaultRole } from './permissions.js'

// A person's account before their first login (ADR 0009): product code that
// records something about a person who may never have logged in (a loan of a
// transponder) calls this inside the transaction of that write, with the TU-ID
// it was given. An existing account is returned as it is. Otherwise the
// directory is asked, and only a person it knows gets an account, with the
// directory's fields, the default role a first login would give (ADR 0011)
// and an audit event naming who caused it. The first login then finds the
// account by its TU-ID and refreshes its fields, as every login does
// (ADR 0008).
//
// The account outlives the directory entry: when the person leaves the
// university, the record of who they are stays with what they still hold.
//
// It is no external service method: who may cause an account is whoever may
// make the write that needs it, which the product's own permission decides.

export interface AccountFor {
  id: string
  // True when this call made the account.
  created: boolean
}

export const accountFor = async (
  app: Application,
  trx: Knex | Knex.Transaction,
  tuId: string,
  { actorId }: { actorId: string | null }
): Promise<AccountFor> => {
  const existing: { id: string } | undefined = await trx('users').where({ tuId }).first('id')
  if (existing) return { id: existing.id, created: false }

  let entry
  try {
    entry = await app.get('directory').find(tuId)
  } catch (error) {
    if (error instanceof DirectoryUnavailable) throw new Unavailable('Directory unavailable')
    throw error
  }
  if (!entry) throw new BadRequest('No person with this TU-ID in the directory')

  let row: { id: string; inserted: boolean } | undefined
  try {
    ;[row] = await trx('users')
      .insert({ tuId: entry.tuId, givenName: entry.givenName, surname: entry.surname, email: entry.email, authSource: 'saml' })
      // A login or another call that made it meanwhile wins; theirs is used.
      .onConflict('tuId')
      .merge(['updatedAt'])
      // xmax is 0 for a row this statement inserted.
      .returning(['id', trx.raw('(xmax = 0) AS inserted')])
  } catch (error) {
    // users_email_key: the directory's address belongs to another account.
    if ((error as { code?: string }).code === '23505') throw new Conflict('The address belongs to another account')
    throw error
  }
  if (!row) throw new Error('account insert returned nothing')
  if (row.inserted) {
    await assignDefaultRole(trx, row.id)
    await recordAudit(trx, { actorId, action: 'users.create', resourceType: 'users', resourceId: row.id })
  }
  return { id: row.id, created: row.inserted }
}
