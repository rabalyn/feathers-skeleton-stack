import { Type, getValidator, type Static } from '@feathersjs/typebox'
import { hooks as schemaHooks } from '@feathersjs/schema'
import type { Params } from '@feathersjs/feathers'
import type { Application } from '../../app.js'
import { LOCALES } from '../../locales.js'
import { dataValidator } from '../../validators.js'
import { USERS_PATH } from './users.js'
import { userExternalResolver, type User, type UserInternalPatch, type UserPatch } from './users.schema.js'

// The caller's own locale (ADR 0011, 0027): the web app writes it whenever
// the person changes language, so mail reaches them in the language they
// last used. Like avatars, it never takes a user id, and goes through an
// internal users patch, so the change is published like any other.

export const LOCALES_PATH = 'locales'
export const LOCALE_EXTERNAL_METHODS = ['create'] as const

export const localeDataSchema = Type.Object(
  { locale: Type.Union(LOCALES.map((locale) => Type.Literal(locale))) },
  { $id: 'LocaleData', additionalProperties: false }
)
export type LocaleData = Static<typeof localeDataSchema>
export const localeDataValidator = getValidator(localeDataSchema, dataValidator)

export class LocaleService {
  constructor(private readonly app: Application) {}

  async create(data: LocaleData, params?: Params): Promise<User> {
    const user = params?.user as { id: string }
    const patch: UserInternalPatch = { locale: data.locale }
    return this.app.service(USERS_PATH).patch(user.id, patch as UserPatch)
  }
}

export const locales = (app: Application) => {
  app.use(LOCALES_PATH, new LocaleService(app), { methods: [...LOCALE_EXTERNAL_METHODS] })
  app.service(LOCALES_PATH).hooks({
    around: { create: [schemaHooks.resolveExternal(userExternalResolver)] },
    before: { create: [schemaHooks.validateData(localeDataValidator)] }
  })
}

declare module '../../app.js' {
  interface ServiceTypes {
    [LOCALES_PATH]: LocaleService
  }
}
