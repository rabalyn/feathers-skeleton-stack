import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { NotAuthenticated } from '@feathersjs/errors'
import { AuthenticationBaseStrategy, type AuthenticationParams, type AuthenticationRequest } from '@feathersjs/authentication'
import type { Knex } from 'knex'
import type { Application } from '../app.js'

// API tokens (ADR 0029): `Authorization: Bearer apt_…` on REST calls. A
// token is 256 random bits behind a fixed prefix, which tells it apart from
// an access token and gives secret scanners a pattern. Only its SHA-256 is
// stored; a slow hash buys nothing against a value nobody can guess.

export const API_TOKEN_STRATEGY = 'api-token'
export const API_TOKEN_PREFIX = 'apt_'
const TOKEN = /^apt_[A-Za-z0-9_-]{43}$/
const BEARER = /^Bearer\s+(\S+)$/i
// last_used_at moves at most this often, so a busy script does not write
// on every request.
const LAST_USED_RESOLUTION = '1 minute'

export const generateApiToken = (): { token: string; hash: string; hint: string } => {
  const token = `${API_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
  return { token, hash: hashApiToken(token), hint: token.slice(-4) }
}

export const hashApiToken = (token: string): string => createHash('sha256').update(token).digest('hex')

export interface ApiTokenGrant {
  id: string
  userId: string
  permissions: string[]
}

// The token's row, if it is live: known, not expired. Whether its owner may
// still use it is decided with their permissions (default-deny).
export const findLiveToken = async (knex: Knex, token: string): Promise<ApiTokenGrant | undefined> => {
  if (!TOKEN.test(token)) return undefined
  const row: ApiTokenGrant | undefined = await knex('apiTokens')
    .where({ tokenHash: hashApiToken(token) })
    .where((query) => {
      void query.whereNull('expiresAt').orWhere('expiresAt', '>', knex.fn.now())
    })
    .first('id', 'userId', 'permissions')
  if (row) {
    await knex('apiTokens')
      .where({ id: row.id })
      .where((query) => {
        void query.whereNull('lastUsedAt').orWhereRaw(`last_used_at < now() - interval '${LAST_USED_RESOLUTION}'`)
      })
      .update({ lastUsedAt: knex.fn.now() })
  }
  return row
}

// Only REST requests reach parse(); the authentication service does not
// accept this strategy (it is not in authStrategies), so no access token is
// ever issued for an API token and no socket authenticates with one.
export class ApiTokenStrategy extends AuthenticationBaseStrategy {
  declare app: Application

  async parse(req: IncomingMessage) {
    const header = req.headers.authorization
    const token = typeof header === 'string' ? BEARER.exec(header)?.[1] : undefined
    if (!token?.startsWith(API_TOKEN_PREFIX)) return null
    return { strategy: API_TOKEN_STRATEGY, accessToken: token }
  }

  async authenticate(authentication: AuthenticationRequest, _params: AuthenticationParams) {
    const token = (authentication as { accessToken?: unknown }).accessToken
    const grant = typeof token === 'string' ? await findLiveToken(this.app.get('knex'), token) : undefined
    if (!grant) throw new NotAuthenticated('Invalid API token')
    const user = await this.app.service('users').get(grant.userId)
    if (!user.enabled) throw new NotAuthenticated('Invalid API token')
    return {
      authentication: { strategy: API_TOKEN_STRATEGY },
      user,
      apiToken: { id: grant.id, permissions: grant.permissions }
    }
  }
}
