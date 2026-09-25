import { performance } from 'node:perf_hooks'
import type { NextFunction } from '@feathersjs/feathers'
import type { Middleware } from '@feathersjs/koa'
import type { Application } from './app.js'
import { normalizeIp, type TrustedProxy } from './client-ip.js'
import type { HookContext } from './declarations.js'
import { API_PREFIX } from './paths.js'
import { isRequestId, newRequestId, runWithRequest } from './request-context.js'

// One log line per HTTP request and per WebSocket call (ADR 0021), with the
// request id every other line of it carries. The route is a template, never
// a path with an id in it (ADR 0022).

// Koa routes outside Feathers' services (ADR 0006, 0008).
const STATIC_ROUTES = new Set([
  `${API_PREFIX}/ping`,
  `${API_PREFIX}/auth/saml/metadata`,
  `${API_PREFIX}/auth/saml/login`,
  `${API_PREFIX}/auth/saml/acs`,
  `${API_PREFIX}/auth/saml/logout`
])

export const serviceRoute = (path: string, id: unknown): string =>
  id === undefined || id === null ? `${API_PREFIX}/${path}` : `${API_PREFIX}/${path}/:id`

// The route template of a public path, or 'unmatched'.
export const routeTemplate = (app: Application, publicPath: string): string => {
  if (STATIC_ROUTES.has(publicPath)) return publicPath
  if (!publicPath.startsWith(`${API_PREFIX}/`)) return 'unmatched'
  const match = app.lookup(publicPath.slice(API_PREFIX.length + 1))
  if (!match) return 'unmatched'
  const path = Object.keys(app.services).find((name) => app.service(name as never) === match.service)
  return path === undefined ? 'unmatched' : serviceRoute(path, match.params.__id)
}

export interface CompletedRequest {
  route: string
  method: string
  status: number
  durationSeconds: number
}

export type RequestObserver = (request: CompletedRequest) => void

const logCompleted = (app: Application, request: CompletedRequest) => {
  app.get('logger').info(
    {
      route: request.route,
      method: request.method,
      status: request.status,
      duration_ms: Math.round(request.durationSeconds * 1000)
    },
    'request'
  )
}

// Outermost Koa middleware. The request id comes from Nginx when the
// connection does (it sends $request_id), and is generated otherwise; the
// response names it, so a user can quote it.
export const httpRequests =
  (app: Application, proxy: TrustedProxy, observe: RequestObserver = () => {}): Middleware =>
  async (ctx, next) => {
    const started = performance.now()
    const publicPath = ctx.path
    const header = ctx.get('x-request-id')
    const peer = normalizeIp(ctx.req.socket.remoteAddress)
    const fromProxy = isRequestId(header) && peer !== undefined && (await proxy.isProxy(peer))
    const request = { requestId: fromProxy ? header : newRequestId() }
    ctx.set('X-Request-Id', request.requestId)

    await runWithRequest(request, async () => {
      try {
        await next()
      } finally {
        const completed = {
          route: routeTemplate(app, publicPath),
          method: ctx.method,
          status: ctx.status,
          durationSeconds: (performance.now() - started) / 1000
        }
        logCompleted(app, completed)
        observe(completed)
      }
    })
  }

// Outermost service hook. A WebSocket call has no HTTP request around it, so
// it gets its request id here; REST calls already have theirs.
export const socketCalls =
  (observe: RequestObserver = () => {}) =>
  async (context: HookContext, next: NextFunction) => {
    if (context.params.provider !== 'socketio') {
      await next()
      return
    }
    const started = performance.now()
    await runWithRequest({ requestId: newRequestId() }, async () => {
      let status = 200
      try {
        await next()
      } catch (error) {
        const code = (error as { code?: unknown }).code
        status = typeof code === 'number' ? code : 500
        throw error
      } finally {
        const completed = {
          route: serviceRoute(context.path, context.id),
          method: context.method,
          status,
          durationSeconds: (performance.now() - started) / 1000
        }
        logCompleted(context.app, completed)
        observe(completed)
      }
    })
  }
