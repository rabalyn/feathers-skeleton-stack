import type { HookContext as FeathersHookContext } from '@feathersjs/feathers'
import type { AppAbility } from './abilities.js'
import type { Application } from './app.js'
import type { User } from './services/users/users.schema.js'

export type HookContext<S = unknown> = FeathersHookContext<Application, S>

declare module '@feathersjs/feathers' {
  interface Params {
    // Set by authentication for external calls; absent for internal ones.
    user?: User
    ability?: AppAbility
  }
}
