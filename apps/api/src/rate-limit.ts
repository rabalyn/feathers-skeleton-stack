import { FeathersError, NotAuthenticated } from '@feathersjs/errors'
import type { NextFunction } from '@feathersjs/feathers'
import type { Redis } from 'ioredis'
import type { HookContext } from './declarations.js'
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
  refresh: 'rateLimitRefreshPerMinute',
  // The break-glass password login: keyed by account and IP together, so a
  // third party cannot lock the account out (ADR 0010).
  passwordLogin: 'rateLimitPasswordLoginPerMinute',
  // Endpoints that are costly or can be turned against someone else, keyed
  // by the authenticated user (limitPerUser).
  // POST /files: stores an upload.
  uploads: 'rateLimitUploadsPerMinute',
  // data-exports create: a worker job, and a mail when it is ready.
  dataExports: 'rateLimitDataExportsPerMinute',
  // mail-campaigns create: mail to many recipients.
  mailCampaigns: 'rateLimitMailCampaignsPerMinute',
  // update-checks create: a job that calls out to the update sources.
  updateChecks: 'rateLimitUpdateChecksPerMinute',
  // directory find: an LDAP search.
  directorySearch: 'rateLimitDirectorySearchPerMinute',
  // sites find and get: a NetBox request.
  siteLookup: 'rateLimitSiteLookupPerMinute'
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

// An around hook counting an external call against a bucket of its own,
// keyed by the person calling (ADR 0010): an API token's owner (ADR 0029),
// in a view-as the one looking (ADR 0028). Placed first among the method's
// hooks, it runs after authentication and authorization, which the app's
// hooks do, so a refused call uses up nobody's limit, and before validation
// or any work. Internal calls are not counted. A refusal is a security
// event (ADR 0021); the log line names the user through the request context.
export const limitPerUser = (bucket: RateLimitBucket) => async (context: HookContext, next: NextFunction) => {
  if (context.params.provider) await countCaller(context, bucket)
  await next()
}

const countCaller = async (context: HookContext, bucket: RateLimitBucket) => {
  const caller = context.params.viewer ?? context.params.user
  if (!caller) throw new NotAuthenticated('Not authenticated')
  try {
    await context.app.get('rateLimiter').hit(bucket, String(caller.id))
  } catch (error) {
    if (error instanceof TooManyRequests) {
      context.app.get('logger').warn({ bucket }, 'rate limit exceeded')
    } else if (error instanceof RateLimitUnavailable) {
      context.app.get('logger').error({ bucket }, 'rate limit unavailable: request refused')
    }
    throw error
  }
}
