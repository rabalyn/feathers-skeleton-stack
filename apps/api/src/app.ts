import { feathers, type HookContext, type NextFunction } from '@feathersjs/feathers'
import { koa, rest, bodyParser, errorHandler, type Application as KoaApplication } from '@feathersjs/koa'
import socketio from '@feathersjs/socketio'
import type { Logger } from 'pino'
import type { Knex } from 'knex'
import type { ApiConfig } from './config.js'
import { authentication, samlRoutes } from './auth/authentication.js'
import type { ServiceProvider } from './auth/saml.js'
import type { SessionStore } from './auth/sessions.js'
import { defaultDeny } from './hooks/default-deny.js'
import { sanitizeHttpErrors, sanitizeServiceErrors } from './hooks/errors.js'
import { services } from './services/index.js'

export const API_PREFIX = '/api'

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ServiceTypes {}

export interface AppSettings {
  config: ApiConfig
  logger: Logger
  knex: Knex
  authentication: Record<string, unknown>
  sessions: SessionStore
  serviceProvider: ServiceProvider
}

export type Application = KoaApplication<ServiceTypes, AppSettings>

export const createApp = (config: ApiConfig, logger: Logger, knex: Knex): Application => {
  const app: Application = koa(feathers())
  app.set('config', config)
  app.set('logger', logger)
  app.set('knex', knex)

  app.use(errorHandler())
  app.use(sanitizeHttpErrors(() => app.get('logger')))

  // Everything public lives under /api (ADR 0016). Nginx passes the path
  // through unchanged; the prefix is stripped here so service names stay
  // unprefixed. Anything outside the prefix is a 404.
  app.use(async (ctx, next) => {
    if (ctx.path !== API_PREFIX && !ctx.path.startsWith(`${API_PREFIX}/`)) {
      ctx.status = 404
      return
    }
    ctx.path = ctx.path.slice(API_PREFIX.length) || '/'
    return next()
  })

  // The only unauthenticated liveness signal on the public port (ADR 0006).
  app.use(async (ctx, next) => {
    if (ctx.method === 'GET' && ctx.path === '/ping') {
      ctx.body = { pong: true }
      return
    }
    return next()
  })

  app.use(bodyParser())
  // SAML needs real HTTP routes the IdP redirects browsers to (ADR 0006).
  samlRoutes(app)
  app.configure(rest())
  app.configure(socketio({ path: `${API_PREFIX}/socket.io`, transports: ['websocket'] }))
  app.configure(services)
  app.configure(authentication)

  // Service hooks for every service (ADR 0011) ...
  app.hooks({ around: { all: [sanitizeServiceErrors(() => app.get('logger')), defaultDeny] } })
  // ... and application lifecycle hooks, which Feathers keeps separate.
  app.hooks({
    teardown: [
      async (_context: HookContext<Application>, next: NextFunction) => {
        await next()
        await knex.destroy()
      }
    ]
  })

  return app
}
