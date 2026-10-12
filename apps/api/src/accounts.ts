import { BadRequest, Conflict, Unavailable } from '@feathersjs/errors'
import type { Knex } from 'knex'
import type { Application } from './app.js'
import { recordAudit } from './audit.js'
import { DirectoryUnavailable, type DirectoryValues } from './directory.js'
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
//
// The further attributes a product reads (product/directory.ts, ADR 0008) are
// asked for in the same lookup and handed to it in the same transaction.

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
    entry = await app.get('directory').find(tuId, app.get('productDirectory').attributes)
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
  await applyDirectoryValues(app, trx, row.id, entry.values)
  return { id: row.id, created: row.inserted }
}

const applyDirectoryValues = async (
  app: Application,
  trx: Knex | Knex.Transaction,
  userId: string,
  values: DirectoryValues
): Promise<void> => {
  const product = app.get('productDirectory')
  if (product.attributes.length > 0) await product.apply(trx, userId, values)
}

// At every login (ADR 0008): the assertion carries the account's own fields
// only, so the further attributes a product reads are looked up by TU-ID with
// the api's service account, and handed to it in a transaction of their own.
// Only when a product names any. A directory that is unreachable or no longer
// knows the person does not stop the login: the product keeps what it had.
export const refreshDirectoryValues = async (app: Application, userId: string, tuId: string): Promise<void> => {
  const { attributes } = app.get('productDirectory')
  if (attributes.length === 0) return
  let entry
  try {
    entry = await app.get('directory').find(tuId, attributes)
  } catch (error) {
    if (!(error instanceof DirectoryUnavailable)) throw error
    app.get('logger').warn({ user_ref: userId, err: { message: error.message } }, 'login: directory unavailable, attributes not refreshed')
    return
  }
  if (!entry) {
    app.get('logger').info({ user_ref: userId }, 'login: not in the directory, attributes not refreshed')
    return
  }
  const { values } = entry
  await app.get('knex').transaction((trx) => applyDirectoryValues(app, trx, userId, values))
}

// An account carried over by a product's import of an older application's
// data (ADR 0009, decided 2026-10-12): a person that application once
// checked against the directory, which no longer knows them, because they
// left the university. Their record has to come along with what they still
// hold, so the account is made from the fields the import read, as they
// are. Only an import calls this, and only for a TU-ID the directory does
// not know: a person it knows gets their account through accountFor. An
// existing account is returned as it is. The account gets the default role,
// and its making is an audit event without an actor, naming the source. A
// login, should the person come back, refreshes its fields as every login
// does.
export interface ImportedPerson {
  tuId: string
  givenName: string
  surname: string
  email: string | null
}

export const importedAccount = async (
  trx: Knex | Knex.Transaction,
  person: ImportedPerson,
  { source }: { source: string }
): Promise<AccountFor> => {
  const existing: { id: string } | undefined = await trx('users').where({ tuId: person.tuId }).first('id')
  if (existing) return { id: existing.id, created: false }

  let row: { id: string } | undefined
  try {
    ;[row] = await trx('users')
      .insert({ tuId: person.tuId, givenName: person.givenName, surname: person.surname, email: person.email, authSource: 'saml' })
      .returning('id')
  } catch (error) {
    const { code, constraint } = error as { code?: string; constraint?: string }
    if (code === '23505' && constraint === 'users_email_key') throw new Conflict('The address belongs to another account')
    throw error
  }
  if (!row) throw new Error('account insert returned nothing')
  await assignDefaultRole(trx, row.id)
  await recordAudit(trx, { actorId: null, action: 'users.create', resourceType: 'users', resourceId: row.id, detail: { source } })
  return { id: row.id, created: true }
}
