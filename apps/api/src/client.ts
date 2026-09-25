// Browser-safe client entry point (ADR 0007). At runtime it may reach only
// the modules the dependency boundary allowlists (.dependency-cruiser.cjs):
// never Knex, pg, the SAML library, resolvers or hooks. Server types are
// imported with `import type`, which leaves nothing at runtime.
import { feathers, type Application, type ClientService, type Paginated, type Params, type TransportConnection } from '@feathersjs/feathers'
import authenticationClient, { MemoryStorage, type AuthenticationClientOptions } from '@feathersjs/authentication-client'
import type { DirectoryEntry, DirectoryPage, DirectoryQuery } from './services/directory/directory.schema.js'
import type { DIRECTORY_EXTERNAL_METHODS } from './services/directory/directory.js'
import type { Setting, SettingPatch, SettingQuery } from './services/settings/settings.schema.js'
import type { SETTING_EXTERNAL_METHODS } from './services/settings/settings.js'
import type { User, UserPatch, UserQuery } from './services/users/users.schema.js'
import type { USER_EXTERNAL_METHODS } from './services/users/users.js'

export type { User, UserPatch, UserQuery } from './services/users/users.schema.js'
export type { Setting, SettingPatch, SettingQuery } from './services/settings/settings.schema.js'
export type { DirectoryEntry, DirectoryPage, DirectoryQuery } from './services/directory/directory.schema.js'
export { ROLES, defineAbilitiesFor, type AbilityUser, type AppAbility, type Role } from './abilities.js'
export { PAGINATE } from './paginate.js'
export { API_PREFIX, AUTHENTICATION_URL, SAML_LOGIN_URL, SOCKET_PATH } from './paths.js'
export { DIRECTORY_MAX_RESULTS, DIRECTORY_MAX_TERM_LENGTH, DIRECTORY_MIN_TERM_LENGTH } from './limits.js'

type External<S, M extends readonly (keyof S)[]> = Pick<S, M[number]>

// The services as a browser sees them: only their external methods, with
// the shapes the schemas give them.
export interface ClientServiceTypes {
  users: External<ClientService<User, never, UserPatch, Paginated<User>, Params<UserQuery>>, typeof USER_EXTERNAL_METHODS>
  settings: External<
    ClientService<Setting, never, SettingPatch, Paginated<Setting>, Params<SettingQuery>>,
    typeof SETTING_EXTERNAL_METHODS
  >
  directory: External<
    ClientService<DirectoryEntry, never, never, DirectoryPage, Params<DirectoryQuery>>,
    typeof DIRECTORY_EXTERNAL_METHODS
  >
}

export type ClientApplication = Application<ClientServiceTypes>

// POST AUTHENTICATION_URL with { strategy: 'refresh' } answers with this and
// sets the rotated cookie; the socket then authenticates with the access
// token under the `jwt` strategy (ADR 0010, 0014).
export interface AuthenticationResponse {
  accessToken: string
  authentication: { strategy: string }
  user: User
}

// DELETE AUTHENTICATION_URL: the session is revoked. Where the login came
// from the IdP, the browser continues to idpLogoutUrl (ADR 0008).
export interface LogoutResponse {
  loggedOut: true
  idpLogoutUrl: string | null
}

// The application's Feathers client over the given connection. The access
// token is held in memory only, whatever the options say: the library's
// default is localStorage, which would defeat the session design (ADR 0010,
// 0014).
export const createClient = (
  connection: TransportConnection<ClientServiceTypes>,
  options: Partial<Omit<AuthenticationClientOptions, 'storage'>> = {}
): ClientApplication => {
  const client: ClientApplication = feathers()
  client.configure(connection)
  // A CommonJS module: under NodeNext its default import is the module
  // object, whose `default` is the configure function in Node and bundlers
  // alike.
  client.configure(authenticationClient.default({ ...options, storage: new MemoryStorage() }))
  return client
}
