import { FeathersError, GeneralError } from '@feathersjs/errors'
import type { NextFunction } from '@feathersjs/feathers'
import type { Middleware } from '@feathersjs/koa'
import type { Logger } from 'pino'
import type { HookContext } from '../declarations.js'

// Unexpected errors never reach the client with their details: a database
// message, a stack or a library's wording tells an attacker about internals
// (ADR 0018, A05). Expected errors (4xx Feathers errors) pass unchanged; the
// rest is logged in full and answered generically.

const INTERNAL = 'Internal error'

// 503 is expected too: a dependency is down and the client should retry
// (the fail-closed rate limiter, ADR 0010).
const isExpected = (error: unknown): boolean =>
  error instanceof FeathersError && ((error.code >= 400 && error.code < 500) || error.code === 503)

// For service calls, whatever the transport (REST and WebSocket alike).
export const sanitizeServiceErrors =
  (logger: () => Logger) => async (context: HookContext, next: NextFunction) => {
    try {
      await next()
    } catch (error) {
      // Internal callers get the real error; they may handle it.
      if (!context.params.provider || isExpected(error)) throw error
      logger().error({ err: error, path: context.path, method: context.method }, 'service error')
      throw new GeneralError(INTERNAL)
    }
  }

// For Koa routes (the SAML routes), wrapped around Feathers' errorHandler.
export const sanitizeHttpErrors =
  (logger: () => Logger): Middleware =>
  async (ctx, next) => {
  try {
    await next()
  } catch (error) {
    if (isExpected(error)) throw error
    logger().error({ err: error, route: `${ctx.method} ${ctx.path}` }, 'request error')
    throw new GeneralError(INTERNAL)
  }
}
