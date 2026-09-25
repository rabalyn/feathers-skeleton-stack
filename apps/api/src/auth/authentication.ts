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
import { SamlRejected, ServiceProvider } from './saml.js'
import { SESSION_ABSOLUTE_MS, SessionStore, isActive, type AuthSession } from './sessions.js'

// Authentication (ADR 0008, 0010). Three strategies behind one Feathers
// authentication service at /api/authentication:
//   jwt      the 15-minute access token; every use re-checks the session row
//   refresh  the HttpOnly cookie; exchanges it for a fresh access token
//   (SAML)   the ACS route validates an assertion and opens the session; the
//            browser then calls refresh, as on every page load (ADR 0014).

export const AUTH_PATH = 'authentication'
export const REFRESH_COOKIE = 'refresh_token'
const COOKIE_PATH = '/api/authentication'
const ACCESS_TOKEN_LIFETIME = '15m'

const readCookie = (header: unknown, name: string): string | undefined => {
  if (typeof header !== 'string') return undefined
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return undefined
}

export const refreshCookie = (token: string, secure = true): string =>
  [
    `${REFRESH_COOKIE}=${token}`,
    `Path=${COOKIE_PATH}`,
    `Max-Age=${Math.floor(SESSION_ABSOLUTE_MS / 1000)}`,
    'HttpOnly',
    ...(secure ? ['Secure'] : []),
    'SameSite=Strict'
  ].join('; ')

export const clearedRefreshCookie = (): string =>
  `${REFRESH_COOKIE}=; Path=${COOKIE_PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Strict`

const sessions = (app: Application): SessionStore => app.get('sessions')

// Refresh and logout carry a cookie, so they additionally require the
// request to come from the application's own origin (ADR 0018).
const assertSameOrigin = (app: Application, params: Params) => {
  const origin = params.headers?.origin
  if (origin !== app.get('config').publicOrigin) {
    throw new Forbidden('Origin not allowed')
  }
}

class SessionJwtStrategy extends JWTStrategy {
  declare app: Application

  async authenticate(authentication: AuthenticationRequest, params: AuthenticationParams) {
    const result = await super.authenticate(authentication, params)
    const payload = result.authentication?.payload as { sid?: string; role?: string; sub?: string } | undefined
    const user = (result as { user?: { id: string; role: string; enabled: boolean } }).user
    const session = payload?.sid ? await sessions(this.app).get(payload.sid) : undefined

    // ADR 0010: revoked or expired session, disabled user, or a role that
    // changed since the token was issued all end access immediately.
    if (!session || !isActive(session) || !user || session.userId !== user.id) {
      throw new NotAuthenticated('Session is no longer valid')
    }
    if (!user.enabled || user.role !== payload?.role) {
      throw new NotAuthenticated('Session is no longer valid')
    }
    return result
  }
}

class RefreshStrategy extends AuthenticationBaseStrategy {
  declare app: Application

  async authenticate(_authentication: AuthenticationRequest, params: AuthenticationParams) {
    assertSameOrigin(this.app, params)
    const token = readCookie(params.headers?.cookie, REFRESH_COOKIE)
    const found = token ? await sessions(this.app).findByRefreshToken(token) : undefined
    const session = found && isActive(found) ? await sessions(this.app).touch(found.id) : undefined
    if (!session) throw new NotAuthenticated('Not authenticated')

    const user = await this.app.service('users').get(session.userId)
    if (!user.enabled) throw new NotAuthenticated('Not authenticated')

    return { authentication: { strategy: 'refresh', sessionId: session.id }, user }
  }
}

class AppAuthenticationService extends AuthenticationService {
  declare app: Application

  // The access token names its session and the role it was issued for.
  async getPayload(authResult: AuthenticationResult, params: AuthenticationParams) {
    const base = await super.getPayload(authResult, params)
    const sid =
      (authResult.authentication as { sessionId?: string; payload?: { sid?: string } } | undefined)?.sessionId ??
      (authResult.authentication as { payload?: { sid?: string } } | undefined)?.payload?.sid
    return { ...base, sid, role: (authResult.user as { role: string }).role }
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
        idpLogoutUrl = await (this.app.get('serviceProvider') as ServiceProvider).logoutUrl({
          nameId: session.samlNameId,
          nameIdFormat: session.samlNameIdFormat,
          sessionIndex: session.samlSessionIndex
        })
      }
    }
    return { loggedOut: true, idpLogoutUrl } as never
  }
}

// Logout always clears the cookie, whatever else happened.
const clearCookieOnLogout = async (context: HookContext) => {
  context.http = { ...context.http, headers: { ...context.http?.headers, 'Set-Cookie': clearedRefreshCookie() } }
}

export const authentication = (app: Application) => {
  const { publicOrigin, authSigningSecret } = app.get('config')
  app.set('authentication', {
    secret: authSigningSecret,
    entity: 'user',
    service: 'users',
    authStrategies: ['jwt', 'refresh'],
    jwtOptions: {
      header: { typ: 'access' },
      audience: publicOrigin,
      issuer: publicOrigin,
      algorithm: 'HS256',
      expiresIn: ACCESS_TOKEN_LIFETIME
    }
  })
  app.set('sessions', new SessionStore(app.get('knex')))
  app.set('serviceProvider', new ServiceProvider(app.get('config'), app.get('knex')))

  const service = new AppAuthenticationService(app)
  service.register('jwt', new SessionJwtStrategy())
  service.register('refresh', new RefreshStrategy())
  app.use(AUTH_PATH, service, { methods: ['create', 'remove'] })
  app.service(AUTH_PATH).hooks({ after: { remove: [clearCookieOnLogout] } })
}

export const samlRoutes = (app: Application) => {
  const sp = (): ServiceProvider => app.get('serviceProvider')
  const logger = () => app.get('logger')

  app.use(async (ctx, next) => {
    if (!ctx.path.startsWith('/auth/saml/')) return next()
    const route = `${ctx.method} ${ctx.path}`

    try {
      switch (route) {
        case 'GET /auth/saml/metadata':
          ctx.type = 'application/samlmetadata+xml'
          ctx.body = sp().metadata()
          return

        case 'GET /auth/saml/login':
          ctx.status = 302
          ctx.redirect(await sp().loginUrl(ctx.query.returnTo))
          return

        case 'POST /auth/saml/acs': {
          const identity = await sp().consume(ctx.request.body as Record<string, string>)
          const users = app.get('knex')('users')
          // Just-in-time provisioning keyed by TU-ID; directory fields are
          // refreshed on every login (ADR 0009).
          const [user] = await users
            .insert({
              tuId: identity.tuId,
              givenName: identity.givenName,
              surname: identity.surname,
              email: identity.email,
              authSource: 'saml'
            })
            .onConflict('tuId')
            .merge(['givenName', 'surname', 'email', 'updatedAt'])
            .returning(['id', 'enabled'])
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
          ctx.set('Set-Cookie', refreshCookie(refreshToken))
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
      if (error instanceof SamlRejected) {
        // Generic answer to the client, the reason only in the log (ADR 0018).
        logger().warn({ route, reason: error.message }, 'SAML rejected')
        ctx.status = 401
        ctx.body = 'Authentication failed'
        return
      }
      throw error
    }
    return next()
  })
}

declare module '../app.js' {
  interface ServiceTypes {
    [AUTH_PATH]: AppAuthenticationService
  }
}
