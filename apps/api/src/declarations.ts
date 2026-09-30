import type { HookContext as FeathersHookContext, Params, ServiceInterface } from '@feathersjs/feathers'
import type { AppAbility } from './abilities.js'
import type { Application } from './app.js'
import type { User } from './services/users/users.schema.js'

// Without a service type, Feathers types params as `any`; a hook for every
// service still gets the application's Params.
export type HookContext<S = ServiceInterface<unknown, unknown, Params>> = FeathersHookContext<Application, S>

declare module '@feathersjs/feathers' {
  interface Params {
    // Set by authentication for external calls; absent for internal ones.
    user?: User
    // During a read-only view-as (ADR 0028), `user` is the person viewed as
    // and `viewer` the one looking.
    viewer?: User
    ability?: AppAbility
    // The client address as established from the proxy headers (ADR 0010).
    clientIp?: string
  }
}
