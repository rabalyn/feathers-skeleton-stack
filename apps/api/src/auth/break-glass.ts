import type { Knex } from 'knex'
import { recordAudit } from '../audit.js'
import type { User } from '../services/users/users.schema.js'
import { generatePassword, hashPassword } from './password.js'

// The break-glass account (ADR 0008): one local `admin`, created and rotated
// only by the bootstrap command. Both return the new password, which exists
// nowhere else: the command prints it once.

export class BreakGlassError extends Error {}

// Deliberately loose: an address someone can read mail at, not RFC 5322.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const localAccount = (trx: Knex.Transaction) =>
  trx<User>('users').where({ authSource: 'local' }).forUpdate().first('id', 'email')

export const createBreakGlass = async (knex: Knex, email: string): Promise<{ userId: string; password: string }> => {
  if (!EMAIL.test(email) || email.length > 254) throw new BreakGlassError(`not an email address: ${email}`)
  const password = generatePassword()
  const passwordHash = await hashPassword(password)
  return knex.transaction(async (trx) => {
    // Serialises two bootstraps; the unique index would stop the second anyway.
    await trx.raw('LOCK TABLE local_credentials IN EXCLUSIVE MODE')
    if (await localAccount(trx)) {
      throw new BreakGlassError('the break-glass account exists already; use --rotate for a new password')
    }
    const taken = await trx<User>('users').whereRaw('lower(email) = lower(?)', [email]).first('id')
    if (taken) throw new BreakGlassError(`${email} belongs to another account`)
    const [user] = await trx<User>('users')
      .insert({ email, givenName: 'Break-glass', surname: 'Admin', role: 'admin', authSource: 'local' })
      .returning(['id'])
    if (!user) throw new Error('user insert returned nothing')
    await trx('localCredentials').insert({ userId: user.id, passwordHash })
    await recordAudit(trx, { actorId: null, action: 'breakglass.create', resourceType: 'users', resourceId: user.id })
    return { userId: user.id, password }
  })
}

// A new password; every session of the account ends, so a leaked password or
// token stops working (ADR 0010: the next request is refused).
export const rotateBreakGlass = async (knex: Knex): Promise<{ userId: string; email: string; password: string }> => {
  const password = generatePassword()
  const passwordHash = await hashPassword(password)
  return knex.transaction(async (trx) => {
    const user = await localAccount(trx)
    if (!user) throw new BreakGlassError('there is no break-glass account yet; run bootstrap without --rotate')
    await trx('localCredentials')
      .insert({ userId: user.id, passwordHash })
      .onConflict('userId')
      .merge({ passwordHash, updatedAt: trx.fn.now() })
    await trx('authSessions').where({ userId: user.id }).whereNull('revokedAt').update({ revokedAt: trx.fn.now() })
    await recordAudit(trx, { actorId: null, action: 'breakglass.rotate', resourceType: 'users', resourceId: user.id })
    return { userId: user.id, email: user.email ?? '', password }
  })
}
