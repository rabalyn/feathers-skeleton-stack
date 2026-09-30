import type { Server } from 'node:http'
import { feathers, type HookContext, type NextFunction } from '@feathersjs/feathers'
import { koa, rest, bodyParser, errorHandler, type Application as KoaApplication } from '@feathersjs/koa'
import socketio from '@feathersjs/socketio'
import { disallow } from 'feathers-utils/hooks'
import type { Logger } from 'pino'
import type { Knex } from 'knex'
import type { Redis } from 'ioredis'
import type { Registry } from 'prom-client'
import type { ApiConfig } from './config.js'
import { authentication, samlRoutes } from './auth/authentication.js'
import { channels } from './channels.js'
import type { ServiceProvider } from './auth/saml.js'
import type { SessionStore } from './auth/sessions.js'
import { TrustedProxy } from './client-ip.js'
import { Directory } from './directory.js'
import { queueConnection } from './jobs/queues.js'
import { MailOutbox } from './mail/outbox.js'
import { defaultDeny } from './hooks/default-deny.js'
import { sanitizeHttpErrors, sanitizeServiceErrors } from './hooks/errors.js'
import { inMaintenance } from './maintenance-mode.js'
import { API_PREFIX, MAINTENANCE_URL, SOCKET_PATH } from './paths.js'
import { RateLimiter } from './rate-limit.js'
import { createRegistry, observeKnexPool, requestMetrics, websocketConnections } from './metrics.js'
import { createReadiness, observeReadiness, type Readiness } from './readiness.js'
import { Storage } from './storage.js'
import { httpRequests, socketCalls } from './request-log.js'
import { services } from './services/index.js'
import { SHUTDOWN_GRACE_MS, trackConnections, withDeadline } from './shutdown.js'
import { SettingsStore } from './settings/store.js'

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ServiceTypes {}

export interface AppSettings {
  config: ApiConfig
  logger: Logger
  knex: Knex
  authentication: Record<string, unknown>
  sessions: SessionStore
  serviceProvider: ServiceProvider
  settings: SettingsStore
  valkey: Redis
  rateLimiter: RateLimiter
  directory: Directory
  metrics: Registry
  readiness: Readiness
  storage: Storage
  // The exports bucket (ADR 0013).
  exports: Storage
  // Notifications are written here, in the transaction of their cause
  // (ADR 0027).
  mail: MailOutbox
}

const MAINTENANCE_ROUTE = MAINTENANCE_URL.slice(API_PREFIX.length)

export interface AppOptions {
  // How long runtime settings are cached in process (ADR 0025).
  settingsTtlMs?: number
  // Namespace of rate-limit keys in Valkey.
  rateLimitPrefix?: string
}

export type Application = KoaApplication<ServiceTypes, AppSettings>

export const createApp = (
  config: ApiConfig,
  logger: Logger,
  knex: Knex,
  valkey: Redis,
  options: AppOptions = {}
): Application => {
  const app: Application = koa(feathers())
  app.set('config', config)
  app.set('logger', logger)
  app.set('knex', knex)
  app.set('settings', new SettingsStore(knex, options.settingsTtlMs))
  app.set('valkey', valkey)
  app.set('rateLimiter', new RateLimiter(valkey, app.get('settings'), options.rateLimitPrefix))
  app.set('directory', new Directory(config))
  app.set('storage', new Storage(config))
  app.set('exports', new Storage(config, config.s3ExportsBucket))
  app.set('mail', new MailOutbox(queueConnection(config), logger, config.queuePrefix))
  const proxy = new TrustedProxy(config.trustedProxyHost)

  // Served by the internal listener (ADR 0022).
  const metrics = createRegistry('api')
  app.set('metrics', metrics)
  observeKnexPool(metrics, knex)
  websocketConnections(metrics, () => (app as { io?: { engine: { clientsCount: number } } }).io?.engine.clientsCount ?? 0)
  const observeRequest = requestMetrics(metrics)
  app.set('readiness', createReadiness(knex, valkey, app.get('storage')))
  observeReadiness(metrics, app.get('readiness'))

  // Outermost, so it sees the status the error handler settled on.
  app.use(httpRequests(app, proxy, observeRequest))
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
    await next()
  })

  // The only unauthenticated liveness signal on the public port (ADR 0006),
  // and whether maintenance mode is on, which the browser polls while it
  // shows its maintenance page (ADR 0025). Without the database that is
  // unknown: 503, and the browser keeps polling.
  app.use(async (ctx, next) => {
    if (ctx.method === 'GET' && ctx.path === '/ping') {
      ctx.body = { pong: true }
      return
    }
    if (ctx.method === 'GET' && ctx.path === MAINTENANCE_ROUTE) {
      ctx.set('Cache-Control', 'no-store')
      try {
        ctx.body = { active: await inMaintenance(app) }
      } catch (error) {
        app.get('logger').warn({ err: { message: (error as Error).message } }, 'maintenance state unknown')
        ctx.status = 503
        ctx.body = { active: null }
      }
      return
    }
    await next()
  })

  // The client address, for rate limits and security events (ADR 0010,
  // 0021). Service calls over REST receive it as params.clientIp.
  app.use(async (ctx, next) => {
    const clientIp = await proxy.clientIp(ctx.req.socket.remoteAddress, ctx.req.headers['x-forwarded-for'])
    ctx.state.clientIp = clientIp
    ctx.feathers = { ...ctx.feathers, clientIp }
    await next()
  })

  app.use(bodyParser())
  // SAML needs real HTTP routes the IdP redirects browsers to (ADR 0006).
  samlRoutes(app)
  app.configure(rest())
  app.configure(socketio({ path: SOCKET_PATH, transports: ['websocket'] }))
  app.configure(channels)
  app.configure(services)
  app.configure(authentication)

  // Service hooks for every service (ADR 0011) ... `update` is rejected for
  // every caller, server code included: `patch` is the only way to change a
  // record, so no `updated` event is ever published (ADR 0006).
  app.hooks({
    around: {
      all: [socketCalls(observeRequest), sanitizeServiceErrors(() => app.get('logger')), defaultDeny],
      update: [disallow()]
    }
  })
  // ... and application lifecycle hooks, which Feathers keeps separate.
  // Teardown is the shutdown on SIGTERM (ADR 0006): Feathers closes the
  // server, which waits for every open connection. Socket.IO connections are
  // closed first, as a transport close, so clients reconnect to the next
  // instance; requests in flight get SHUTDOWN_GRACE_MS, then their sockets are
  // destroyed.
  let destroyConnections = () => {}
  app.hooks({
    setup: [
      async (context: HookContext<Application> & { server?: Server }, next: NextFunction) => {
        if (context.server) destroyConnections = trackConnections(context.server)
        await next()
      }
    ],
    teardown: [
      async (_context: HookContext<Application>, next: NextFunction) => {
        ;(app as { io?: { engine: { close(): void } } }).io?.engine.close()
        const closing = next()
        await withDeadline(closing, SHUTDOWN_GRACE_MS, destroyConnections)
        await closing
        await app.get('mail').close()
        await knex.destroy()
        valkey.disconnect()
        app.get('storage').close()
        app.get('exports').close()
      }
    ]
  })

  return app
}
