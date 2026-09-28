import { AUTHENTICATION_URL, type AuthenticationResponse } from '@app/api/client'

// Session restore and renewal (ADR 0010, 0014). Kept free of Vue and of the
// Feathers client so it can be tested on its own.

export type RefreshOutcome =
  // A new access token; the cookie has been rotated.
  | { kind: 'ok'; response: AuthenticationResponse }
  // The session is gone (no cookie, revoked, expired, disabled account):
  // the user has to log in again.
  | { kind: 'rejected' }
  // The server could not answer (offline, rate limited, 503 while Valkey is
  // down, a restart): the session may well be intact, so nobody is logged
  // out; the caller retries.
  | { kind: 'transient' }

// One refresh at a time across all tabs of this origin: they share the
// cookie, and a tab presenting a token another tab has just rotated away
// would look like theft (ADR 0010). The browser releases the lock of a tab
// that dies.
export const REFRESH_LOCK = 'app:auth-refresh'

export interface RefreshDependencies {
  fetch: typeof fetch
  locks: Pick<LockManager, 'request'>
}

const defaults = (): RefreshDependencies => ({ fetch: globalThis.fetch.bind(globalThis), locks: navigator.locks })

// 401 and 403 are answers about the session: 401 when it is gone, 403 when
// the request is refused as cross-origin, which no retry fixes. Everything
// else that is not a success is the server being unable to decide.
export const classifyStatus = (status: number): 'ok' | 'rejected' | 'transient' => {
  if (status === 201 || status === 200) return 'ok'
  if (status === 401 || status === 403) return 'rejected'
  return 'transient'
}

export const requestRefresh = async (deps: RefreshDependencies = defaults()): Promise<RefreshOutcome> =>
  deps.locks.request(REFRESH_LOCK, async (): Promise<RefreshOutcome> => {
    let response: Response
    try {
      // The HttpOnly cookie is scoped to this path and sent by the browser;
      // the script never sees it.
      response = await deps.fetch(AUTHENTICATION_URL, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ strategy: 'refresh' })
      })
    } catch {
      return { kind: 'transient' }
    }
    const kind = classifyStatus(response.status)
    if (kind !== 'ok') return { kind }
    try {
      const body = (await response.json()) as AuthenticationResponse
      if (typeof body.accessToken !== 'string' || !body.user) return { kind: 'transient' }
      return { kind: 'ok', response: body }
    } catch {
      return { kind: 'transient' }
    }
  })

// The access token's payload. The signature is the server's business; the
// browser only reads what the token says about itself.
const accessTokenPayload = (token: string): Record<string, unknown> => {
  const payload = token.split('.')[1]
  if (!payload) return {}
  try {
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '='))
    const parsed: unknown = JSON.parse(json)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

// When the access token expires, in epoch milliseconds, for scheduling.
export const accessTokenExpiry = (token: string): number | null => {
  const { exp } = accessTokenPayload(token)
  return typeof exp === 'number' ? exp * 1000 : null
}

// The session the access token belongs to (ADR 0010): the one this browser
// is logged in with, among the user's sessions.
export const accessTokenSession = (token: string): string | null => {
  const { sid } = accessTokenPayload(token)
  return typeof sid === 'string' ? sid : null
}

// How long to wait before renewing: a minute before expiry, never sooner
// than five seconds from now (a short-lived token or a skewed clock must not
// turn this into a loop).
export const RENEW_BEFORE_MS = 60_000
export const MIN_DELAY_MS = 5_000
export const renewalDelay = (expiresAt: number | null, now: number): number =>
  expiresAt === null ? MIN_DELAY_MS : Math.max(MIN_DELAY_MS, expiresAt - now - RENEW_BEFORE_MS)

// Retry delays after a transient failure: 2, 4, 8 … seconds, at most one
// minute.
export const retryDelay = (attempt: number): number => Math.min(60_000, 2_000 * 2 ** Math.max(0, attempt))
