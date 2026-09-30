import { NotAuthenticated } from '@feathersjs/errors'
import { authenticate } from '@feathersjs/authentication'
import type { NextFunction } from '@feathersjs/feathers'
import { authorize } from 'feathers-casl'
import { defineAbilitiesFor, defineTokenAbility, defineViewAsAbility } from '../abilities.js'
import { API_TOKEN_STRATEGY } from '../auth/api-tokens.js'
import { loadAccess } from '../permissions.js'
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
// The session-checking JWT strategy (ADR 0010), for REST and WebSocket
// alike, and API tokens, which only REST requests carry (ADR 0029).
const jwt = authenticate('jwt', API_TOKEN_STRATEGY)

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
  const knex = context.app.get('knex')
  const viewer = context.params.viewer
  // From here on, log lines of this call name the user, and whom they view
  // as (ADR 0021, 0028).
  const request = currentRequest()
  if (request) request.userRef = (viewer ?? user).id
  if (request && viewer) request.viewAsRef = user.id
  // Loaded afresh for every call, so a changed role or assignment applies
  // at once (ADR 0011); in a view-as, both people's.
  const own = { id: user.id, ...(await loadAccess(knex, user.id)) }
  // An API token: what was chosen for it, as far as its owner still holds
  // it, and only while the owner may create tokens at all (ADR 0029).
  const apiToken = context.params.apiToken
  if (apiToken) {
    if (request) request.apiTokenRef = apiToken.id
    if (!own.permissions.includes('api-tokens.create')) throw new NotAuthenticated('Invalid API token')
    context.params.ability = defineTokenAbility(own, apiToken.permissions)
    await casl(context, next)
    return
  }
  context.params.ability = viewer
    ? defineViewAsAbility({ id: viewer.id, ...(await loadAccess(knex, viewer.id)) }, own)
    : defineAbilitiesFor(own)
  await casl(context, next)
}
