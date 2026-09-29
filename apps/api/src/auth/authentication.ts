import { NotAuthenticated, Forbidden } from '@feathersjs/errors'
import {
  AuthenticationBaseStrategy,
  AuthenticationService,
  JWTStrategy,
  type AuthenticationParams,
  type AuthenticationRequest,
  type AuthenticationResult
} from '@feathersjs/authentication'
import type { HookContext, Params } from '@feathersjs/feathers'
import type { Application } from '../app.js'
import { recordAudit } from '../audit.js'
import { endSessionConnections } from '../channels.js'
import { AUTHENTICATION_URL } from '../paths.js'
import { assignDefaultRole } from '../permissions.js'
import { publishSession } from '../services/sessions/sessions.js'
import type { User } from '../services/users/users.schema.js'
import { decoyHash, MAX_PASSWORD_LENGTH, verifyPassword } from './password.js'
import { RateLimitUnavailable, TooManyRequests, type RateLimitBucket } from '../rate-limit.js'
import { SamlRejected, ServiceProvider } from './saml.js'
import { SessionStore, isActive, type AuthSession } from './sessions.js'

// Authentication (ADR 0008, 0010). Four strategies behind one Feathers
// authentication service at /api/authentication:
//   jwt      the 15-minute access token; every use re-checks the session row
//   refresh  the HttpOnly cookie; rotates it and issues a fresh access token
//   password the break-glass account's email and password; opens a session
//            like the ACS does
//   (SAML)   the ACS route validates an assertion and opens the session; the
//            browser then calls refresh, as on every page load (ADR 0014).

export const AUTH_PATH = 'authentication'
export const REFRESH_COOKIE = 'refresh_token'
// The cookie reaches refresh and logout, and nothing else.
const COOKIE_PATH = AUTHENTICATION_URL
const ACCESS_TOKEN_LIFETIME = '15m'

const readCookie = (header: unknown, name: string): string | undefined => {
  if (typeof header !== 'string') return undefined
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return undefined
}

// The cookie lives exactly as long as the token family may.
export const refreshCookie = (token: string, familyExpiresAt: Date, secure = true): string =>
  [
    `${REFRESH_COOKIE}=${token}`,
    `Path=${COOKIE_PATH}`,
    `Max-Age=${Math.max(0, Math.floor((familyExpiresAt.getTime() - Date.now()) / 1000))}`,
    'HttpOnly',
    ...(secure ? ['Secure'] : []),
    'SameSite=Strict'
  ].join('; ')

export const clearedRefreshCookie = (): string =>
  `${REFRESH_COOKIE}=; Path=${COOKIE_PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Strict`

const sessions = (app: Application): SessionStore => app.get('sessions')

// Counts an attempt against its fail-closed limit (ADR 0010). A refusal is a
// security event and names the client address (ADR 0021).
const limit = async (app: Application, bucket: RateLimitBucket, clientIp: string | undefined) => {
  try {
    await app.get('rateLimiter').hit(bucket, clientIp ?? 'unknown')
  } catch (error) {
    if (error instanceof TooManyRequests) {
      app.get('logger').warn({ bucket, client_ip: clientIp }, 'rate limit exceeded')
    } else if (error instanceof RateLimitUnavailable) {
      app.get('logger').error({ bucket, client_ip: clientIp }, 'rate limit unavailable: attempt refused')
    }
    throw error
  }
}

// Refresh and logout carry a cookie, so they additionally require the
// request to come from the application's own origin (ADR 0018).
const assertSameOrigin = (app: Application, params: Params) => {
  const origin: unknown = params.headers?.origin
  if (origin !== app.get('config').publicOrigin) {
    throw new Forbidden('Origin not allowed')
  }
}

class SessionJwtStrategy extends JWTStrategy {
  declare app: Application

  async authenticate(authentication: AuthenticationRequest, params: AuthenticationParams) {
    const result = await super.authenticate(authentication, params)
    const payload = result.authentication?.payload as { sid?: string; sub?: string } | undefined
    const user = (result as { user?: { id: string; enabled: boolean } }).user
    const session = payload?.sid ? await sessions(this.app).get(payload.sid) : undefined

    // ADR 0010: a revoked or expired session or a disabled user ends access
    // immediately. Permissions are loaded afresh on every request (ADR 0011),
    // so the token carries none.
    if (!session || !isActive(session) || !user || session.userId !== user.id) {
      throw new NotAuthenticated('Session is no longer valid')
    }
    if (!user.enabled) {
      throw new NotAuthenticated('Session is no longer valid')
    }
    return result
  }
}

class RefreshStrategy extends AuthenticationBaseStrategy {
  declare app: Application

  async authenticate(_authentication: AuthenticationRequest, params: AuthenticationParams) {
    assertSameOrigin(this.app, params)
    await limit(this.app, 'refresh', params.clientIp)
    const token = readCookie(params.headers?.cookie, REFRESH_COOKIE)
    const outcome = token ? await sessions(this.app).refresh(token) : ({ status: 'rejected' } as const)
    if (outcome.status === 'reuse') {
      this.app.get('logger').warn({ user_ref: outcome.session.userId, session_ref: outcome.session.id }, 'refresh token reuse: session revoked')
    }
    if (outcome.status !== 'rotated') throw new NotAuthenticated('Not authenticated')
    const { session, refreshToken } = outcome

    const user = await this.app.service('users').get(session.userId)
    if (!user.enabled) throw new NotAuthenticated('Not authenticated')

    // The rotated token leaves as a cookie only (setRotatedCookie below).
    return {
      authentication: { strategy: 'refresh', sessionId: session.id, refreshToken, familyExpiresAt: session.familyExpiresAt },
      user
    }
  }
}

// The break-glass login (ADR 0008). Over REST only, since it answers with
// the refresh cookie, and from the application's own origin. Every attempt,
// successful or not, is an audit event; the answer never says which part
// was wrong.
class PasswordStrategy extends AuthenticationBaseStrategy {
  declare app: Application

  async authenticate(authentication: AuthenticationRequest, params: AuthenticationParams) {
    if (params.provider !== 'rest') throw new NotAuthenticated('Not authenticated')
    assertSameOrigin(this.app, params)
    const { email, password } = authentication as { email?: unknown; password?: unknown }
    if (
      typeof email !== 'string' ||
      typeof password !== 'string' ||
      email.length > 254 ||
      password.length > MAX_PASSWORD_LENGTH
    ) {
      throw new NotAuthenticated('Invalid login')
    }
    await limit(this.app, 'passwordLogin', `${email.toLowerCase()}|${params.clientIp ?? 'unknown'}`)

    const knex = this.app.get('knex')
    const account = await knex('users')
      .join('localCredentials', 'localCredentials.userId', 'users.id')
      .where('users.authSource', 'local')
      .whereRaw('lower(users.email) = lower(?)', [email])
      .first<{ id: string; enabled: boolean; passwordHash: string } | undefined>('users.id', 'users.enabled', 'localCredentials.passwordHash')
    const valid = await verifyPassword(password, account?.passwordHash ?? (await decoyHash()))

    if (!account || !valid || !account.enabled) {
      const reason = !account ? 'unknown account' : !valid ? 'wrong password' : 'account disabled'
      this.app.get('logger').warn({ user_ref: account?.id, client_ip: params.clientIp, reason }, 'break-glass login refused')
      await recordAudit(knex, {
        actorId: account?.id ?? null,
        action: 'login.refused',
        resourceType: 'users',
        resourceId: account?.id ?? null,
        detail: { method: 'password', reason }
      })
      throw new NotAuthenticated('Invalid login')
    }

    const { session, refreshToken } = await sessions(this.app).issue(account.id, {
      userAgent: typeof params.headers?.['user-agent'] === 'string' ? params.headers['user-agent'] : undefined
    })
    this.app.get('logger').warn({ user_ref: account.id, client_ip: params.clientIp }, 'break-glass login')
    await recordAudit(knex, {
      actorId: account.id,
      action: 'login',
      resourceType: 'authSessions',
      resourceId: session.id,
      detail: { method: 'password' }
    })
    const user = await this.app.service('users').get(account.id)
    return {
      authentication: { strategy: 'password', sessionId: session.id, refreshToken, familyExpiresAt: session.familyExpiresAt },
      user
    }
  }
}

class AppAuthenticationService extends AuthenticationService {
  declare app: Application

  // The access token names its session.
  async getPayload(authResult: AuthenticationResult, params: AuthenticationParams) {
    const base = await super.getPayload(authResult, params)
    const sid =
      (authResult.authentication as { sessionId?: string; payload?: { sid?: string } } | undefined)?.sessionId ??
      (authResult.authentication as { payload?: { sid?: string } } | undefined)?.payload?.sid
    return { ...base, sid }
  }

  // Logout: revokes the session behind the cookie and, where the login came
  // from the IdP, returns the URL of a signed SAML LogoutRequest the browser
  // should visit next (SP-initiated logout, ADR 0008).
  async remove(_id: null | string, params: AuthenticationParams) {
    assertSameOrigin(this.app, params)
    const token = readCookie(params.headers?.cookie, REFRESH_COOKIE)
    const session: AuthSession | undefined = token ? await sessions(this.app).findByRefreshToken(token) : undefined
    let idpLogoutUrl: string | null = null
    if (session) {
      await sessions(this.app).revoke(session.id)
      await recordAudit(this.app.get('knex'), {
        actorId: session.userId,
        action: 'logout',
        resourceType: 'authSessions',
        resourceId: session.id
      })
      if (session.samlNameId) {
        idpLogoutUrl = await this.app.get('serviceProvider').logoutUrl({
          nameId: session.samlNameId,
          nameIdFormat: session.samlNameIdFormat,
          sessionIndex: session.samlSessionIndex
        })
      }
    }
    return { loggedOut: true, idpLogoutUrl } as never
  }
}

// A refresh answers with the rotated token as a cookie, never in the body:
// the browser's script must not be able to read it (ADR 0010).
const setRotatedCookie = async (context: HookContext) => {
  const authentication = (context.result as { authentication?: { refreshToken?: string; familyExpiresAt?: Date } })
    ?.authentication
  if (!authentication?.refreshToken || !authentication.familyExpiresAt) return
  context.http = {
    ...context.http,
    headers: {
      ...context.http?.headers,
      'Set-Cookie': refreshCookie(authentication.refreshToken, authentication.familyExpiresAt)
    }
  }
  delete authentication.refreshToken
  delete authentication.familyExpiresAt
}

// Logout always clears the cookie, whatever else happened.
const clearCookieOnLogout = async (context: HookContext) => {
  context.http = { ...context.http, headers: { ...context.http?.headers, 'Set-Cookie': clearedRefreshCookie() } }
}

export const authentication = (app: Application) => {
  const { publicOrigin, authSigningSecret, refreshTokenKey } = app.get('config')
  app.set('authentication', {
    secret: authSigningSecret,
    entity: 'user',
    service: 'users',
    authStrategies: ['jwt', 'refresh', 'password'],
    jwtOptions: {
      header: { typ: 'access' },
      audience: publicOrigin,
      issuer: publicOrigin,
      algorithm: 'HS256',
      expiresIn: ACCESS_TOKEN_LIFETIME
    }
  })
  app.set(
    'sessions',
    new SessionStore(app.get('knex'), app.get('settings'), refreshTokenKey, {
      issued: (session) => publishSession(app, 'created', session),
      refreshed: (session) => publishSession(app, 'patched', session),
      revoked: (session) => {
        endSessionConnections(app, session.id)
        publishSession(app, 'removed', session)
      }
    })
  )
  app.set('serviceProvider', new ServiceProvider(app.get('config'), app.get('knex')))

  const service = new AppAuthenticationService(app)
  service.register('jwt', new SessionJwtStrategy())
  service.register('refresh', new RefreshStrategy())
  service.register('password', new PasswordStrategy())
  app.use(AUTH_PATH, service, { methods: ['create', 'remove'] })
  app.service(AUTH_PATH).hooks({ after: { create: [setRotatedCookie], remove: [clearCookieOnLogout] } })
}

const clientIpOf = (ctx: { state: { clientIp?: unknown } }): string | undefined =>
  typeof ctx.state.clientIp === 'string' ? ctx.state.clientIp : undefined

export const samlRoutes = (app: Application) => {
  const sp = (): ServiceProvider => app.get('serviceProvider')
  const logger = () => app.get('logger')

  app.use(async (ctx, next) => {
    if (!ctx.path.startsWith('/auth/saml/')) {
      await next()
      return
    }
    const route = `${ctx.method} ${ctx.path}`

    try {
      switch (route) {
        case 'GET /auth/saml/metadata':
          ctx.type = 'application/samlmetadata+xml'
          ctx.body = sp().metadata()
          return

        case 'GET /auth/saml/login':
          await limit(app, 'samlLogin', clientIpOf(ctx))
          ctx.status = 302
          ctx.redirect(await sp().loginUrl(ctx.query.returnTo))
          return

        case 'POST /auth/saml/acs': {
          await limit(app, 'samlAcs', clientIpOf(ctx))
          const identity = await sp().consume(ctx.request.body as Record<string, string>)
          const users = app.get('knex')<User>('users')
          // Just-in-time provisioning keyed by TU-ID; directory fields are
          // refreshed on every login (ADR 0009).
          const [user]: { id: string; enabled: boolean; inserted: boolean }[] = await users
            .insert({
              tuId: identity.tuId,
              givenName: identity.givenName,
              surname: identity.surname,
              email: identity.email,
              authSource: 'saml'
            })
            .onConflict('tuId')
            .merge(['givenName', 'surname', 'email', 'updatedAt'])
            // xmax is 0 for a row this statement inserted.
            .returning(['id', 'enabled', app.get('knex').raw('(xmax = 0) AS inserted')])
          // A new account gets `user` (ADR 0011).
          if (user?.inserted) await assignDefaultRole(app.get('knex'), user.id)
          if (!user?.enabled) {
            logger().warn({ user_ref: user?.id }, 'login refused: account disabled')
            await recordAudit(app.get('knex'), {
              actorId: user?.id ?? null,
              action: 'login.refused',
              resourceType: 'users',
              resourceId: user?.id ?? null,
              detail: { reason: 'account disabled' }
            })
            ctx.status = 403
            ctx.body = 'Account disabled'
            return
          }
          const { session, refreshToken } = await app.get('sessions').issue(user.id, {
            userAgent: ctx.get('user-agent'),
            saml: { nameId: identity.nameId, nameIdFormat: identity.nameIdFormat, sessionIndex: identity.sessionIndex }
          })
          logger().info({ user_ref: user.id }, 'login')
          await recordAudit(app.get('knex'), {
            actorId: user.id,
            action: 'login',
            resourceType: 'authSessions',
            resourceId: session.id,
            detail: { method: 'saml' }
          })
          ctx.set('Set-Cookie', refreshCookie(refreshToken, session.familyExpiresAt))
          ctx.status = 303
          ctx.redirect(identity.returnTo)
          return
        }

        case 'GET /auth/saml/logout':
        case 'POST /auth/saml/logout': {
          // The IdP's answer to our LogoutRequest; the session is already
          // revoked, so a bad response only changes what the browser sees.
          await sp().validateLogoutResponse(
            ctx.method === 'POST'
              ? { body: ctx.request.body as Record<string, string> }
              : { query: ctx.query as Record<string, string>, originalQuery: ctx.querystring }
          )
          ctx.status = 303
          ctx.redirect('/')
          return
        }
      }
    } catch (error) {
      if (error instanceof TooManyRequests) {
        ctx.status = 429
        ctx.set('Retry-After', String((error.data as { retryAfterSeconds: number }).retryAfterSeconds))
        ctx.body = 'Too many requests'
        return
      }
      if (error instanceof RateLimitUnavailable) {
        ctx.status = 503
        ctx.body = 'Service unavailable'
        return
      }
      if (error instanceof SamlRejected) {
        // Generic answer to the client, the reason only in the log (ADR 0018).
        logger().warn({ route, reason: error.message }, 'SAML rejected')
        ctx.status = 401
        ctx.body = 'Authentication failed'
        return
      }
      throw error
    }
    await next()
  })
}

declare module '../app.js' {
  interface ServiceTypes {
    [AUTH_PATH]: AppAuthenticationService
  }
}
