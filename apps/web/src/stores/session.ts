import {
  defineAbilitiesFor,
  defineViewAsAbility,
  SAML_LOGIN_URL,
  AUTHENTICATION_URL,
  type AppAbility,
  type AuthenticationResponse,
  type LogoutResponse,
  type Role,
  type User
} from '@app/api/client'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef, watch } from 'vue'
import { client, socket } from '@/api/feathers'
import { fetchMaintenanceState, isMaintenanceRefusal } from '@/api/maintenance'
import { accessTokenExpiry, accessTokenSession, renewalDelay, requestRefresh, retryDelay } from '@/api/refresh'
import { i18n } from '@/boot/i18n'

// The browser's side of the session (ADR 0010, 0014). The access token lives
// in the Feathers client's in-memory storage and nowhere else; the refresh
// token is an HttpOnly cookie this code never sees.
//
//   starting       no answer yet; nothing authenticated is rendered
//   authenticated  a user, an access token, an authenticated socket
//   anonymous      no session: the login page
//   maintenance    maintenance mode keeps this browser out, or the API does
//                  not answer: the maintenance page (ADR 0025)
export type SessionStatus = 'starting' | 'authenticated' | 'anonymous' | 'maintenance'

// How long a closed socket may stay closed before the API counts as gone.
const UNREACHABLE_AFTER_MS = 5_000

export const useSessionStore = defineStore('session', () => {
  const status = ref<SessionStatus>('starting')
  const user = ref<User | null>(null)
  // The last attempt could not reach the server. Shown, never a logout.
  const unavailable = ref(false)
  // Set when an authenticated session ended without the user logging out.
  const expired = ref(false)
  const ability = shallowRef<AppAbility | null>(null)
  // The permissions page's role preview (ADR 0011): menus and actions as the
  // role would show them, built in the browser. Presentation only; every
  // call is still made, and answered, with the user's own rights.
  const preview = shallowRef<{ role: Role; ability: AppAbility } | null>(null)
  // A read-only view-as (ADR 0028): `user` is then the person viewed as,
  // and this the one looking, until `expiresAt`.
  const viewAs = shallowRef<{ viewer: User; expiresAt: string } | null>(null)
  // The session this browser is logged in with, from the access token.
  const sessionId = ref<string | null>(null)
  // Whether maintenance mode is on while this person is let in anyway,
  // which only those who may switch it off are (ADR 0025): the banner.
  const maintenanceOn = ref(false)

  let timer: ReturnType<typeof setTimeout> | undefined
  let viewAsTimer: ReturnType<typeof setTimeout> | undefined
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
    preview.value = null
    viewAs.value = null
    clearTimeout(viewAsTimer)
    sessionId.value = null
    status.value = 'anonymous'
  }

  // The permissions arrive with the user's own record from the server; an
  // event about the record carries none (ADR 0011), and the copy on hand
  // stays until the next authentication, which a change of them forces.
  const setUser = (next: User) => {
    const permissions = next.permissions ?? user.value?.permissions ?? []
    user.value = { ...next, permissions }
    const own = { id: next.id, permissions, roleIds: next.roleIds }
    const viewer = viewAs.value?.viewer
    ability.value = viewer
      ? defineViewAsAbility({ id: viewer.id, permissions: viewer.permissions ?? [], roleIds: viewer.roleIds }, own)
      : defineAbilitiesFor(own)
  }

  // `everyone`: the permissions of the role every account holds besides.
  const startPreview = (role: Role, everyone: readonly string[] = []) => {
    if (!user.value) return
    const permissions = [...new Set([...(role.permissions ?? []), ...everyone])]
    const roleIds = role.kind === 'everyone' ? [] : [role.id]
    preview.value = { role, ability: defineAbilitiesFor({ id: user.value.id, permissions, roleIds }) }
  }
  const endPreview = () => (preview.value = null)

  // Authenticates the socket with the current access token. The server
  // checks the session on every call anyway; this attaches the connection
  // to it (ADR 0012).
  const authenticateSocket = async (accessToken: string) => {
    const result = (await client.authenticate({ strategy: 'jwt', accessToken })) as unknown as AuthenticationResponse
    clearTimeout(viewAsTimer)
    viewAs.value = result.viewer && result.viewAs ? { viewer: result.viewer, expiresAt: result.viewAs.expiresAt } : null
    setUser(result.user)
    // When it runs out, the server ends it on the next call; this is that
    // call, so the screen does not show the other person any longer.
    if (viewAs.value) {
      const left = new Date(viewAs.value.expiresAt).getTime() - Date.now()
      viewAsTimer = setTimeout(() => void reauthenticate(), Math.max(left, 0) + 1000)
    }
  }

  const reauthenticate = async () => {
    const token = await client.authentication.getAccessToken()
    if (token) await authenticateSocket(token).catch(() => refresh())
    else await refresh()
  }

  // Maintenance mode keeps this browser out, or the API is gone: nothing of
  // the session stays, the socket stops trying, and the maintenance page
  // takes over. That page reloads the application once the mode is over, so
  // nothing needs to be put back here.
  const enterMaintenance = async () => {
    if (status.value === 'maintenance') return
    clearTimeout(timer)
    clearTimeout(viewAsTimer)
    await client.authentication.removeAccessToken()
    await client.authentication.reset()
    socket.disconnect()
    user.value = null
    ability.value = null
    preview.value = null
    viewAs.value = null
    sessionId.value = null
    unavailable.value = false
    maintenanceOn.value = false
    status.value = 'maintenance'
  }

  // The API did not answer: a maintenance window, unless it says otherwise
  // the next moment.
  const unreachable = async (): Promise<boolean> => {
    if ((await fetchMaintenanceState()) === 'inactive') return false
    await enterMaintenance()
    return true
  }

  // Read-only view-as (ADR 0028). The server moves this connection into the
  // other person's channels; authenticating again brings their record and
  // the intersected ability here.
  const startViewAs = async (userId: string) => {
    preview.value = null
    await client.service('view-as').create({ userId })
    await reauthenticate()
  }
  const endViewAs = async () => {
    await client.service('view-as').remove('current')
    await reauthenticate()
  }

  const runRefresh = async (): Promise<SessionStatus> => {
    const outcome = await requestRefresh()
    if (outcome.kind === 'rejected') {
      await becomeAnonymous()
      return status.value
    }
    if (outcome.kind === 'maintenance') {
      await enterMaintenance()
      return status.value
    }
    if (outcome.kind === 'unreachable' && (await unreachable())) return status.value
    if (outcome.kind === 'transient' || outcome.kind === 'unreachable') {
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
    sessionId.value = accessTokenSession(accessToken)
    status.value = 'authenticated'
    void fetchMaintenanceState().then((state) => (maintenanceOn.value = state === 'active'))
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

  // The server closes the socket when the session's rights changed (roles,
  // the account, a revoked session) or its access token ran out unrenewed
  // (ADR 0012). Socket.IO does not reconnect by itself after that; the
  // connect handler above then re-authenticates, refreshing where the token
  // no longer holds.
  socket.on('disconnect', (reason) => {
    if (reason === 'io server disconnect' && !endingSession) socket.connect()
    // The API went away (a stop for maintenance, ADR 0025): if it is still
    // gone a moment later, the maintenance page waits for it.
    if ((reason === 'transport close' || reason === 'ping timeout') && status.value === 'authenticated') {
      setTimeout(() => {
        if (socket.disconnected && status.value === 'authenticated') void unreachable()
      }, UNREACHABLE_AFTER_MS)
    }
  })

  // An admin sees maintenance mode switched, here or elsewhere, at once.
  client.service('settings').on('patched', (setting: { key: string; value: unknown }) => {
    if (setting.key === 'maintenanceMode') maintenanceOn.value = setting.value === true
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
  // tab, roles assigned by an admin): its event keeps this copy current.
  client.service('users').on('patched', (next: User) => {
    if (status.value === 'authenticated' && next.id === user.value?.id) setUser(next)
  })

  // Mail reaches the person in the language they last used here (ADR 0027):
  // whenever the one on screen differs from their record, it is written. A
  // failed write is tried again with the next change.
  watch(
    () => [status.value, user.value?.locale, i18n.global.locale.value] as const,
    ([current, stored, chosen]) => {
      // Never while viewing as somebody: it would be their record.
      if (current !== 'authenticated' || viewAs.value || !stored || stored === chosen) return
      client
        .service('locales')
        .create({ locale: chosen })
        .then(setUser, () => undefined)
    }
  )

  // A call refused as unauthenticated means the session changed under us
  // (revoked, roles changed, disabled): find out which.
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
          if (isMaintenanceRefusal(context.error)) void enterMaintenance()
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
  ): Promise<'ok' | 'invalid' | 'limited' | 'unavailable' | 'maintenance'> => {
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
    if (response.status === 503 && isMaintenanceRefusal(await response.json().catch(() => null))) {
      await enterMaintenance()
      return 'maintenance'
    }
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

  // What the screen offers: the previewed role's ability while a preview
  // runs, the user's own otherwise.
  const shown = () => preview.value?.ability ?? ability.value

  // Whether the user may do this to any record of the subject at all …
  const can = (action: string, subject: string) => shown()?.can(action, subject) ?? false
  // … and whether to every record, which is what a list or an editor for
  // the whole subject needs: everybody may read their own user record, but
  // only some may read the users list (ADR 0011).
  const canAll = (action: string, subject: string) =>
    shown()?.rulesFor(action, subject).some((rule) => !rule.inverted && !rule.conditions) ?? false

  return {
    status,
    user,
    unavailable,
    expired,
    ability,
    preview,
    viewAs,
    sessionId,
    maintenanceOn,
    settled,
    isAuthenticated: computed(() => status.value === 'authenticated'),
    start,
    refresh,
    login,
    passwordLogin,
    logout,
    can,
    canAll,
    startPreview,
    endPreview,
    startViewAs,
    endViewAs
  }
})
