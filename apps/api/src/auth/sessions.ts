import { createHash, createHmac, randomBytes } from 'node:crypto'
import type { Knex } from 'knex'
import { recordAudit } from '../audit.js'
import type { SettingsStore } from '../settings/store.js'

// Sessions in PostgreSQL, checked on every authenticated request (ADR 0010).
//
// An auth_sessions row is one login: one refresh token family, with an idle
// and an absolute expiry. Its refresh tokens are rows of auth_refresh_tokens,
// stored as hashes only. Every refresh rotates the token; presenting a
// rotated-away token revokes the family, except inside the grace window,
// where it yields the family's current token.
//
// Successors are derived, not random: successor = HMAC(key, predecessor).
// So the server can hand out the *same* current token again inside the
// grace window without ever storing a token, and concurrent refreshes from
// one browser converge on one cookie. The first token of a family is random.

export interface AuthSession {
  id: string
  userId: string
  issuedAt: Date
  lastUsedAt: Date
  idleExpiresAt: Date
  familyExpiresAt: Date
  revokedAt: Date | null
  userAgent: string | null
  samlNameId: string | null
  samlNameIdFormat: string | null
  samlSessionIndex: string | null
}

export interface SamlLoginContext {
  nameId?: string | null
  nameIdFormat?: string | null
  sessionIndex?: string | null
}

interface RefreshTokenRow {
  id: string
  sessionId: string
  tokenHash: Buffer
  issuedAt: Date
  rotatedAt: Date | null
}

export type RefreshOutcome =
  | { status: 'rotated'; session: AuthSession; refreshToken: string }
  | { status: 'rejected' }
  | { status: 'reuse'; session: AuthSession }

// How far the grace path follows successors. Each step is one refresh inside
// the window, so a real chain is a handful long.
const MAX_GRACE_STEPS = 16

// 256 random bits; a plain SHA-256 is enough to make the stored value useless.
export const hashRefreshToken = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest()

export const isActive = (session: AuthSession, now = new Date()): boolean =>
  session.revokedAt === null && session.idleExpiresAt > now && session.familyExpiresAt > now

const SESSION_COLUMNS: string[] = [
  'id',
  'userId',
  'issuedAt',
  'lastUsedAt',
  'idleExpiresAt',
  'familyExpiresAt',
  'revokedAt',
  'userAgent',
  'samlNameId',
  'samlNameIdFormat',
  'samlSessionIndex'
]

// Told after a session changed, once its transaction has committed: to end
// a revoked session's sockets and to publish every change to those who see
// sessions (ADR 0011, 0012).
export interface SessionEvents {
  issued?: (session: AuthSession) => void
  refreshed?: (session: AuthSession) => void
  revoked?: (session: AuthSession) => void
}

export class SessionStore {
  constructor(
    private readonly knex: Knex,
    private readonly settings: SettingsStore,
    private readonly refreshTokenKey: string,
    private readonly events: SessionEvents = {}
  ) {}

  successorOf(token: string): string {
    return createHmac('sha256', this.refreshTokenKey).update(`refresh-successor\0${token}`, 'utf8').digest('base64url')
  }

  async issue(
    userId: string,
    { userAgent, saml }: { userAgent?: string | undefined; saml?: SamlLoginContext } = {}
  ): Promise<{ session: AuthSession; refreshToken: string }> {
    const [idle, absolute] = await Promise.all([
      this.settings.get('sessionIdleSeconds'),
      this.settings.get('sessionAbsoluteSeconds')
    ])
    const refreshToken = randomBytes(32).toString('base64url')
    const issued = await this.knex.transaction(async (trx) => {
      const [session]: AuthSession[] = await trx('authSessions')
        .insert({
          userId,
          familyExpiresAt: trx.raw('now() + make_interval(secs => ?)', [absolute]),
          idleExpiresAt: trx.raw('now() + make_interval(secs => ?)', [Math.min(idle, absolute)]),
          userAgent: userAgent?.slice(0, 256) ?? null,
          samlNameId: saml?.nameId ?? null,
          samlNameIdFormat: saml?.nameIdFormat ?? null,
          samlSessionIndex: saml?.sessionIndex ?? null
        })
        .returning(SESSION_COLUMNS)
      if (!session) throw new Error('session insert returned nothing')
      await trx('authRefreshTokens').insert({ sessionId: session.id, tokenHash: hashRefreshToken(refreshToken) })
      return { session, refreshToken }
    })
    this.events.issued?.(issued.session)
    return issued
  }

  async get(id: string): Promise<AuthSession | undefined> {
    return this.knex<AuthSession>('authSessions').where({ id }).first(SESSION_COLUMNS)
  }

  // The session a presented token belongs to, whether or not the token is
  // still current. For logout, which ends the family either way.
  async findByRefreshToken(token: string): Promise<AuthSession | undefined> {
    return this.knex<AuthSession>('authSessions')
      .join('authRefreshTokens', 'authRefreshTokens.sessionId', 'authSessions.id')
      .where('authRefreshTokens.tokenHash', hashRefreshToken(token))
      .first(SESSION_COLUMNS.map((c) => `authSessions.${c}`))
  }

  // Exchanges a presented refresh token for the family's next one. The
  // session row is locked for the duration, so concurrent refreshes of one
  // family are serialised and see each other's rotations.
  async refresh(token: string): Promise<RefreshOutcome> {
    const grace = await this.settings.get('refreshGraceSeconds')
    const idle = await this.settings.get('sessionIdleSeconds')

    const outcome = await this.knex.transaction(async (trx): Promise<RefreshOutcome> => {
      const tokenHash = hashRefreshToken(token)
      const found = await trx<RefreshTokenRow>('authRefreshTokens').where({ tokenHash }).first('sessionId')
      if (!found) return { status: 'rejected' }

      const session: AuthSession | undefined = await trx('authSessions')
        .where({ id: found.sessionId })
        .forUpdate()
        .first(SESSION_COLUMNS)
      if (!session || !isActive(session)) return { status: 'rejected' }

      // Read again under the lock: a concurrent refresh may have rotated it.
      const presented = await trx<RefreshTokenRow>('authRefreshTokens')
        .where({ tokenHash })
        .first<(Pick<RefreshTokenRow, 'id' | 'rotatedAt'> & { withinGrace: boolean | null }) | undefined>(
          'id',
          'rotatedAt',
          trx.raw('rotated_at > now() - make_interval(secs => ?) AS within_grace', [grace])
        )
      if (!presented) return { status: 'rejected' }

      // Which token the caller is entitled to hold now.
      let current: string | undefined
      if (presented.rotatedAt === null) {
        const successor = this.successorOf(token)
        await trx('authRefreshTokens').where({ id: presented.id }).update({ rotatedAt: trx.fn.now() })
        await trx('authRefreshTokens').insert({ sessionId: session.id, tokenHash: hashRefreshToken(successor) })
        current = successor
      } else if (presented.withinGrace) {
        current = await this.currentDescendant(trx, session.id, token)
      }

      if (current === undefined) {
        // A rotated-away token outside the grace window: someone else holds
        // a copy. End the whole family.
        await trx('authSessions').where({ id: session.id }).update({ revokedAt: trx.fn.now() })
        await recordAudit(trx, {
          actorId: session.userId,
          action: 'session.reuse-detected',
          resourceType: 'authSessions',
          resourceId: session.id
        })
        return { status: 'reuse', session }
      }

      const [touched]: AuthSession[] = await trx('authSessions')
        .where({ id: session.id })
        .update({
          lastUsedAt: trx.fn.now(),
          idleExpiresAt: trx.raw('least(now() + make_interval(secs => ?), family_expires_at)', [idle])
        } as never)
        .returning(SESSION_COLUMNS)
      return { status: 'rotated', session: touched ?? session, refreshToken: current }
    })
    if (outcome.status === 'reuse') this.events.revoked?.({ ...outcome.session, revokedAt: new Date() })
    if (outcome.status === 'rotated') this.events.refreshed?.(outcome.session)
    return outcome
  }

  // Follows derived successors from a rotated token to the family's current
  // one. Undefined if the chain leaves the family or never reaches it.
  private async currentDescendant(trx: Knex.Transaction, sessionId: string, token: string): Promise<string | undefined> {
    let candidate = token
    for (let step = 0; step < MAX_GRACE_STEPS; step++) {
      candidate = this.successorOf(candidate)
      const row = await trx<RefreshTokenRow>('authRefreshTokens')
        .where({ tokenHash: hashRefreshToken(candidate), sessionId })
        .first('rotatedAt')
      if (!row) return undefined
      if (row.rotatedAt === null) return candidate
    }
    return undefined
  }

  // Revokes the session if it is not already; returns it as revoked, or
  // undefined if there was nothing to revoke.
  async revoke(id: string): Promise<AuthSession | undefined> {
    const [revoked]: AuthSession[] = await this.knex('authSessions')
      .where({ id })
      .whereNull('revokedAt')
      .update({ revokedAt: this.knex.fn.now() })
      .returning(SESSION_COLUMNS)
    if (revoked) this.events.revoked?.(revoked)
    return revoked
  }
}
