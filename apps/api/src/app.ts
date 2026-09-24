import { feathers } from '@feathersjs/feathers'
import { koa, rest, bodyParser, errorHandler, type Application as KoaApplication } from '@feathersjs/koa'
import socketio from '@feathersjs/socketio'
import type { Logger } from 'pino'
import type { Config } from './config.js'

export const API_PREFIX = '/api'

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ServiceTypes {}

export interface AppSettings {
  config: Config
  logger: Logger
}

export type Application = KoaApplication<ServiceTypes, AppSettings>

export const createApp = (config: Config, logger: Logger): Application => {
  const app: Application = koa(feathers())
  app.set('config', config)
  app.set('logger', logger)

  app.use(errorHandler())

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
  app.configure(rest())
  app.configure(socketio({ path: `${API_PREFIX}/socket.io`, transports: ['websocket'] }))

  return app
}
