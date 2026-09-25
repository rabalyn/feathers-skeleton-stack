import { NotAuthenticated } from '@feathersjs/errors'
import type { HookContext, NextFunction } from '@feathersjs/feathers'
import { authorize } from 'feathers-casl'
import { defineAbilitiesFor } from '../abilities.js'

// ADR 0011: every external call to every service is authenticated and
// authorized unless the service is on this allowlist. A service without
// rules is usable by nobody, which is the safe failure mode.
//
// GET /api/ping and the SAML routes are Koa routes, not services; the
// authentication service joins this list with the session work.
export const PUBLIC_SERVICES: ReadonlySet<string> = new Set<string>([])

const casl = authorize({ adapter: '@feathersjs/knex' })

export const defaultDeny = async (context: HookContext, next: NextFunction) => {
  // Internal calls (no provider) are trusted server code.
  if (!context.params.provider || PUBLIC_SERVICES.has(context.path)) {
    return next()
  }
  const user = context.params.user
  if (!user) {
    throw new NotAuthenticated('Not authenticated')
  }
  context.params.ability = defineAbilitiesFor(user)
  return casl(context, next)
}
