import { BadRequest, FeathersError, GeneralError, NotAuthenticated } from '@feathersjs/errors'
import type { NextFunction } from '@feathersjs/feathers'
import { ERROR } from '@feathersjs/knex'
import type { Middleware } from '@feathersjs/koa'
import type { Logger } from 'pino'
import type { HookContext } from '../declarations.js'
import type { ValidationError } from '../validation-error.js'

// What an error tells a client (ADR 0018, A05). Unexpected errors never
// reach it with their details: a database message, a stack or a library's
// wording tells an attacker about internals. They are logged in full and
// answered generically. Expected errors (4xx, and 503) keep their class and
// the application's own wording, but nothing a library put into them:
//
//   - a schema validation failure says which fields failed, never the rule,
//     the pattern or the allowed values (decided 2026-10-02);
//   - a 401 says one of the application's own messages, never why a token
//     was refused (ADR 0018, A07);
//   - an error the database adapter turned into a 4xx says nothing of the
//     statement, the constraint or the values;
//   - a body the parser refused is a 4xx, not a server error (rejectBody).

const INTERNAL = 'Internal error'
const INVALID_DATA: ValidationError['message'] = 'Invalid data'

// 503 is expected too: a dependency is down and the client should retry
// (the fail-closed rate limiter, ADR 0010).
const isExpected = (error: unknown): error is FeathersError =>
  error instanceof FeathersError && ((error.code >= 400 && error.code < 500) || error.code === 503)

// The application's own 401 messages; anything else (the JWT library's
// "jwt expired", "invalid signature", the authentication service naming its
// strategies) becomes the first.
const AUTHENTICATION_MESSAGES: ReadonlySet<string> = new Set([
  'Not authenticated',
  'Invalid login',
  'Invalid API token',
  'Session is no longer valid'
])

interface SchemaError {
  instancePath: string
  params?: { missingProperty?: unknown; additionalProperty?: unknown }
}

const isSchemaErrors = (data: unknown): data is SchemaError[] =>
  Array.isArray(data) && data.length > 0 && data.every((entry) => typeof (entry as SchemaError)?.instancePath === 'string')

// `/title` and a missing `title` are both `title`; `/$select/1` is `$select.1`.
const fieldOf = ({ instancePath, params }: SchemaError): string => {
  const extra = params?.missingProperty ?? params?.additionalProperty
  return [...instancePath.split('/').filter(Boolean), ...(typeof extra === 'string' ? [extra] : [])].join('.')
}

const GENERIC: Record<number, string> = { 400: INVALID_DATA, 401: 'Not authenticated', 403: 'Forbidden', 404: 'Not found', 409: 'Conflict', 503: 'Service unavailable' }

// The error a client may see for an expected one.
export const publicError = (error: FeathersError): FeathersError => {
  if ((error as { [ERROR]?: unknown })[ERROR] !== undefined) {
    return new FeathersError(GENERIC[error.code] ?? 'Request failed', error.name, error.code, error.className, undefined)
  }
  if (error.code === 401) {
    return new NotAuthenticated(AUTHENTICATION_MESSAGES.has(error.message) ? error.message : 'Not authenticated')
  }
  if (error.code === 400 && isSchemaErrors(error.data)) {
    // Shaped as validationErrorSchema.
    const errors: ValidationError['errors'] = [...new Set(error.data.map(fieldOf))].map((field) => ({ field }))
    return new BadRequest(INVALID_DATA, { errors })
  }
  return error
}

// For service calls, whatever the transport (REST and WebSocket alike).
export const sanitizeServiceErrors =
  (logger: () => Logger) => async (context: HookContext, next: NextFunction) => {
    try {
      await next()
    } catch (error) {
      // Internal callers get the real error; they may handle it.
      if (!context.params.provider) throw error
      if (isExpected(error)) throw publicError(error)
      logger().error({ err: error, path: context.path, method: context.method }, 'service error')
      throw new GeneralError(INTERNAL)
    }
  }

// For everything over HTTP that is not a service call: the SAML routes, and
// what the body parser refused (rejectBody).
export const sanitizeHttpErrors =
  (logger: () => Logger): Middleware =>
  async (ctx, next) => {
  try {
    await next()
  } catch (error) {
    if (isExpected(error)) throw publicError(error)
    logger().error({ err: error, route: `${ctx.method} ${ctx.path}` }, 'request error')
    throw new GeneralError(INTERNAL)
  }
}

// The body parser's onError: whatever it could not read is the client's
// error, never a server error and never in the parser's words. Over the
// limit is a 413 (raw-body's status); malformed JSON a plain SyntaxError.
export const rejectBody = (error: unknown): never => {
  const { status } = (error ?? {}) as { status?: unknown }
  if (status === 413) throw new FeathersError('Request body too large', 'PayloadTooLarge', 413, 'payload-too-large', undefined)
  if (status === 415) throw new FeathersError('Unsupported media type', 'UnsupportedMediaType', 415, 'unsupported-media-type', undefined)
  throw new BadRequest('Invalid request body')
}
