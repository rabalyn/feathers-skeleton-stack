import { NotAuthenticated } from '@feathersjs/errors'
import { authenticate } from '@feathersjs/authentication'
import type { NextFunction } from '@feathersjs/feathers'
import { authorize } from 'feathers-casl'
import { defineAbilitiesFor } from '../abilities.js'
import type { HookContext } from '../declarations.js'
import { currentRequest } from '../request-context.js'

// ADR 0011: every external call to every service is authenticated and
// authorized unless the service is on this allowlist. A service without
// rules is usable by nobody, which is the safe failure mode.
//
// GET /api/ping and the SAML routes are Koa routes, not services. The
// authentication service authenticates by itself (refresh cookie, origin
// check) and so is public here.
export const PUBLIC_SERVICES: ReadonlySet<string> = new Set<string>(['authentication'])

const casl = authorize({ adapter: '@feathersjs/knex' })
// The session-checking JWT strategy (ADR 0010), for REST and WebSocket alike.
const jwt = authenticate('jwt')

export const defaultDeny = async (context: HookContext, next: NextFunction) => {
  // Internal calls (no provider) are trusted server code.
  if (!context.params.provider || PUBLIC_SERVICES.has(context.path)) {
    await next()
    return
  }
  await jwt(context)
  const user = context.params.user
  if (!user) {
    throw new NotAuthenticated('Not authenticated')
  }
  // From here on, log lines of this call name the user (ADR 0021).
  const request = currentRequest()
  if (request) request.userRef = user.id
  context.params.ability = defineAbilitiesFor(user)
  await casl(context, next)
}
