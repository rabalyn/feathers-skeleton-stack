import { FeathersError } from '@feathersjs/errors'
import type { Redis } from 'ioredis'
import type { SettingKey } from './settings/registry.js'
import type { SettingsStore } from './settings/store.js'

// Rate limits in Valkey (ADR 0010): fixed one-minute windows per bucket and
// subject, limits from runtime settings (ADR 0025). If Valkey cannot answer,
// the attempt is refused (fail closed).

const WINDOW_MS = 60_000

export const RATE_LIMITS = {
  // GET /auth/saml/login: each call stores an authentication request.
  samlLogin: 'rateLimitSamlLoginPerMinute',
  // POST /auth/saml/acs: keyed by IP, no account is known yet.
  samlAcs: 'rateLimitSamlAcsPerMinute',
  refresh: 'rateLimitRefreshPerMinute'
} as const satisfies Record<string, SettingKey>

export type RateLimitBucket = keyof typeof RATE_LIMITS

export class TooManyRequests extends FeathersError {
  constructor(retryAfterSeconds: number) {
    super('Too many requests', 'TooManyRequests', 429, 'too-many-requests', { retryAfterSeconds })
  }
}

export class RateLimitUnavailable extends FeathersError {
  constructor() {
    super('Service unavailable', 'Unavailable', 503, 'unavailable', {})
  }
}

export class RateLimiter {
  constructor(
    private readonly valkey: Redis,
    private readonly settings: SettingsStore,
    private readonly prefix = 'rl'
  ) {}

  // Counts one attempt; throws TooManyRequests over the limit and
  // RateLimitUnavailable when Valkey does not answer.
  async hit(bucket: RateLimitBucket, subject: string): Promise<void> {
    const limit = await this.settings.get(RATE_LIMITS[bucket])
    const key = `${this.prefix}:${bucket}:${subject}`
    let count: number
    let ttl: number
    try {
      const results = await this.valkey.multi().incr(key).pexpire(key, WINDOW_MS, 'NX').pttl(key).exec()
      if (!results || results.some(([error]) => error)) throw new Error('rate limit transaction failed')
      count = Number(results[0]?.[1])
      ttl = Number(results[2]?.[1])
    } catch {
      throw new RateLimitUnavailable()
    }
    if (count > limit) throw new TooManyRequests(Math.max(1, Math.ceil(ttl / 1000)))
  }
}
