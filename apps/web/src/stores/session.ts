import { defineAbilitiesFor, SAML_LOGIN_URL, AUTHENTICATION_URL, type AppAbility, type LogoutResponse, type User } from '@app/api/client'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef, watch } from 'vue'
import { client, socket } from '@/api/feathers'
import { accessTokenExpiry, renewalDelay, requestRefresh, retryDelay } from '@/api/refresh'
import { i18n } from '@/boot/i18n'

// The browser's side of the session (ADR 0010, 0014). The access token lives
// in the Feathers client's in-memory storage and nowhere else; the refresh
// token is an HttpOnly cookie this code never sees.
//
//   starting       no answer yet; nothing authenticated is rendered
//   authenticated  a user, an access token, an authenticated socket
//   anonymous      no session: the login page
export type SessionStatus = 'starting' | 'authenticated' | 'anonymous'

export const useSessionStore = defineStore('session', () => {
  const status = ref<SessionStatus>('starting')
  const user = ref<User | null>(null)
  // The last attempt could not reach the server. Shown, never a logout.
  const unavailable = ref(false)
  // Set when an authenticated session ended without the user logging out.
  const expired = ref(false)
  const ability = shallowRef<AppAbility | null>(null)

  let timer: ReturnType<typeof setTimeout> | undefined
  let attempt = 0
  let inFlight: Promise<SessionStatus> | null = null
  let settle: (status: SessionStatus) => void = () => {}
  // Set while this tab logs out: revoking the session closes the socket
  // (ADR 0012), and that must not be taken for a session to restore.
  let endingSession = false
  // Resolves once the first refresh has an answer, however long an outage
  // delays it; the router waits on it.
  const settled = new Promise<SessionStatus>((resolve) => (settle = resolve))

  const schedule = (delay: number) => {
    clearTimeout(timer)
    timer = setTimeout(() => void refresh(), delay)
  }

  const becomeAnonymous = async () => {
    clearTimeout(timer)
    if (status.value === 'authenticated') expired.value = true
    await client.authentication.removeAccessToken()
    await client.authentication.reset()
    // A new, unauthenticated connection: the old one must not keep the
    // session's authentication or its channels (ADR 0012).
    socket.disconnect().connect()
    user.value = null
    ability.value = null
    status.value = 'anonymous'
  }

  const setUser = (next: User) => {
    user.value = next
    ability.value = defineAbilitiesFor(next)
  }

  // Authenticates the socket with the current access token. The server
  // checks the session on every call anyway; this attaches the connection
  // to it (ADR 0012).
  const authenticateSocket = async (accessToken: string) => {
    const result = await client.authenticate({ strategy: 'jwt', accessToken })
    setUser(result.user as User)
  }

  const runRefresh = async (): Promise<SessionStatus> => {
    const outcome = await requestRefresh()
    if (outcome.kind === 'rejected') {
      await becomeAnonymous()
      return status.value
    }
    if (outcome.kind === 'transient') {
      unavailable.value = true
      schedule(retryDelay(attempt++))
      return status.value
    }
    const { accessToken, user: refreshedUser } = outcome.response
    try {
      setUser(refreshedUser)
      await authenticateSocket(accessToken)
    } catch (error) {
      // A token just issued and refused at once means the session ended in
      // between; anything else is the connection.
      if ((error as { code?: number }).code === 401) {
        await becomeAnonymous()
        return status.value
      }
      unavailable.value = true
      schedule(retryDelay(attempt++))
      return status.value
    }
    attempt = 0
    unavailable.value = false
    expired.value = false
    status.value = 'authenticated'
    schedule(renewalDelay(accessTokenExpiry(accessToken), Date.now()))
    return status.value
  }

  // Concurrent callers share one attempt. A logout in progress wants no new
  // session state: its revocation would read as the session expiring.
  const refresh = (): Promise<SessionStatus> => {
    if (endingSession) return Promise.resolve(status.value)
    inFlight ??= runRefresh().finally(() => (inFlight = null))
    return inFlight
  }

  // A transient failure leaves the status at `starting` with a retry
  // scheduled, so `settled` waits for the first real answer.
  watch(status, (value) => {
    if (value !== 'starting') settle(value)
  })
  const start = () => void refresh()

  // After a reconnect the server has forgotten the connection's
  // authentication: attach it again, refreshing first if the token expired
  // meanwhile.
  socket.on('connect', () => {
    if (status.value !== 'authenticated' || endingSession) return
    void client.authentication
      .getAccessToken()
      .then((token) => (token ? authenticateSocket(token) : Promise.reject(new Error('no token'))))
      .catch(() => refresh())
  })

  // The server closes the socket when the session's rights changed (a role,
  // the account, a revoked session) or its access token ran out unrenewed
  // (ADR 0012). Socket.IO does not reconnect by itself after that; the
  // connect handler above then re-authenticates, refreshing where the token
  // no longer holds.
  socket.on('disconnect', (reason) => {
    if (reason === 'io server disconnect' && !endingSession) socket.connect()
  })

  // Background tabs have their timers throttled; catch up on return.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || status.value !== 'authenticated') return
    void client.authentication.getAccessToken().then((token) => {
      const expiresAt = token ? accessTokenExpiry(token) : null
      if (expiresAt === null || renewalDelay(expiresAt, Date.now()) <= 5_000) void refresh()
    })
  })

  // The user's own record changes elsewhere too (an avatar set in another
  // tab, a role assigned by an admin): its event keeps this copy current.
  client.service('users').on('patched', (next: User) => {
    if (status.value === 'authenticated' && next.id === user.value?.id) setUser(next)
  })

  // Mail reaches the person in the language they last used here (ADR 0027):
  // whenever the one on screen differs from their record, it is written. A
  // failed write is tried again with the next change.
  watch(
    () => [status.value, user.value?.locale, i18n.global.locale.value] as const,
    ([current, stored, chosen]) => {
      if (current !== 'authenticated' || !stored || stored === chosen) return
      client
        .service('locales')
        .create({ locale: chosen })
        .then(setUser, () => undefined)
    }
  )

  // A call refused as unauthenticated means the session changed under us
  // (revoked, role changed, disabled): find out which.
  client.hooks({
    error: {
      all: [
        async (context) => {
          const code = (context.error as { code?: number } | undefined)?.code
          // Authentication's own failures are handled where they happen; it
          // is not among the typed services, hence the widening.
          const path: string = context.path
          if (code === 401 && path !== 'authentication' && status.value === 'authenticated') {
            void refresh()
          }
        }
      ]
    }
  })

  // The SAML login is a full-page redirect (ADR 0014); the API brings the
  // browser back to `returnTo`, a same-origin path.
  const login = (returnTo = '/') => {
    window.location.assign(`${SAML_LOGIN_URL}?${new URLSearchParams({ returnTo }).toString()}`)
  }

  // The break-glass login (ADR 0008): email and password over REST, which
  // answers with the refresh cookie; the session then starts like any other,
  // with a refresh. The answer never says which part was wrong.
  const passwordLogin = async (
    email: string,
    password: string
  ): Promise<'ok' | 'invalid' | 'limited' | 'unavailable'> => {
    let response: Response
    try {
      response = await fetch(AUTHENTICATION_URL, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ strategy: 'password', email, password })
      })
    } catch {
      return 'unavailable'
    }
    if (response.status === 401 || response.status === 403) return 'invalid'
    if (response.status === 429) return 'limited'
    if (!response.ok) return 'unavailable'
    return (await refresh()) === 'authenticated' ? 'ok' : 'unavailable'
  }

  // Revokes the session behind the cookie, then continues to the IdP's
  // logout where the login came from there (ADR 0008). Throws when the
  // server could not confirm it: the session would still be alive.
  const logout = async () => {
    endingSession = true
    let answer: LogoutResponse
    try {
      const response = await fetch(AUTHENTICATION_URL, { method: 'DELETE', credentials: 'same-origin' })
      if (!response.ok) throw Object.assign(new Error('Logout failed'), { code: response.status })
      answer = (await response.json()) as LogoutResponse
    } catch (error) {
      // The session may have ended anyway, and a renewal may have been
      // skipped meanwhile: re-authenticating finds out, from a reconnect
      // where the socket was closed.
      endingSession = false
      if (socket.disconnected) socket.connect()
      else void refresh()
      throw error
    }
    clearTimeout(timer)
    await client.authentication.removeAccessToken()
    // A full navigation also drops every store and the socket.
    window.location.assign(answer.idpLogoutUrl ?? '/')
  }

  // Whether the user may do this to any record of the subject at all …
  const can = (action: string, subject: string) => ability.value?.can(action, subject) ?? false
  // … and whether to every record, which is what a list or an editor for
  // the whole subject needs: everybody may read their own user record, but
  // only some may read the users list (ADR 0011).
  const canAll = (action: string, subject: string) =>
    ability.value?.rulesFor(action, subject).some((rule) => !rule.inverted && !rule.conditions) ?? false

  return {
    status,
    user,
    unavailable,
    expired,
    ability,
    settled,
    isAuthenticated: computed(() => status.value === 'authenticated'),
    start,
    refresh,
    login,
    passwordLogin,
    logout,
    can,
    canAll
  }
})
