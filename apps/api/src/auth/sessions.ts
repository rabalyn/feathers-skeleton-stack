import { createHash, randomBytes } from 'node:crypto'
import type { Knex } from 'knex'

// Sessions in PostgreSQL, checked on every authenticated request (ADR 0010).
// Rotation, reuse detection and the grace window arrive with slice 2; until
// then a refresh extends the idle window of the same row.

// Runtime settings once the settings table exists (ADR 0025).
export const SESSION_IDLE_MS = 8 * 60 * 60 * 1000
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000

export interface AuthSession {
  id: string
  userId: string
  familyId: string
  issuedAt: Date
  lastUsedAt: Date
  idleExpiresAt: Date
  familyExpiresAt: Date
  rotatedAt: Date | null
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

// 256 random bits; a plain SHA-256 is enough to make the stored value useless.
export const hashRefreshToken = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest()

export const isActive = (session: AuthSession, now = new Date()): boolean =>
  session.revokedAt === null && session.idleExpiresAt > now && session.familyExpiresAt > now

export class SessionStore {
  constructor(private readonly knex: Knex) {}

  async issue(
    userId: string,
    { userAgent, saml }: { userAgent?: string | undefined; saml?: SamlLoginContext } = {}
  ): Promise<{ session: AuthSession; refreshToken: string }> {
    const refreshToken = randomBytes(32).toString('base64url')
    const now = Date.now()
    const [session] = await this.knex<AuthSession>('authSessions')
      .insert({
        userId,
        refreshTokenHash: hashRefreshToken(refreshToken),
        idleExpiresAt: new Date(now + SESSION_IDLE_MS),
        familyExpiresAt: new Date(now + SESSION_ABSOLUTE_MS),
        userAgent: userAgent?.slice(0, 256) ?? null,
        samlNameId: saml?.nameId ?? null,
        samlNameIdFormat: saml?.nameIdFormat ?? null,
        samlSessionIndex: saml?.sessionIndex ?? null
      } as never)
      .returning('*')
    if (!session) throw new Error('session insert returned nothing')
    return { session, refreshToken }
  }

  async get(id: string): Promise<AuthSession | undefined> {
    return this.knex<AuthSession>('authSessions').where({ id }).first()
  }

  async findByRefreshToken(token: string): Promise<AuthSession | undefined> {
    return this.knex<AuthSession>('authSessions')
      .where({ refreshTokenHash: hashRefreshToken(token) } as never)
      .first()
  }

  // Extends the idle window, never past the family's absolute expiry. Only
  // an active session is extended; the returned row is undefined otherwise.
  async touch(id: string): Promise<AuthSession | undefined> {
    const [session] = await this.knex<AuthSession>('authSessions')
      .where({ id })
      .whereNull('revokedAt')
      .where('idleExpiresAt', '>', this.knex.fn.now())
      .where('familyExpiresAt', '>', this.knex.fn.now())
      .update({
        lastUsedAt: this.knex.fn.now(),
        idleExpiresAt: this.knex.raw('least(now() + ?::interval, family_expires_at)', [`${SESSION_IDLE_MS} milliseconds`])
      } as never)
      .returning('*')
    return session
  }

  async revoke(id: string): Promise<void> {
    await this.knex('authSessions').where({ id }).whereNull('revokedAt').update({ revokedAt: this.knex.fn.now() })
  }
}
