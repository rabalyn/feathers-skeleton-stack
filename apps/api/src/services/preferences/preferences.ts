import { BadRequest, MethodNotAllowed } from '@feathersjs/errors'
import type { Params } from '@feathersjs/feathers'
import { KnexService } from '@feathersjs/knex'
import { hooks as schemaHooks } from '@feathersjs/schema'
import type { Application } from '../../app.js'
import { publishTo, userChannel } from '../../channels.js'
import type { HookContext } from '../../declarations.js'
import { PAGINATE } from '../../paginate.js'
import { preferenceError } from '../../preferences/registry.js'
import {
  preferenceDataResolver,
  preferenceDataValidator,
  preferenceExternalResolver,
  preferenceQueryResolver,
  preferenceQueryValidator,
  preferenceResolver,
  type Preference,
  type PreferenceData,
  type PreferenceQuery
} from './preferences.schema.js'

// A person's own preferences (decided 2026-10-02, ADR 0014), kept in the
// database so they follow the person to every browser. Who may keep them is
// `profile.preferences` in abilities.ts (ADR 0011); every row is the
// caller's.

export type PreferenceParams = Params<PreferenceQuery>

export class PreferenceService extends KnexService<Preference, PreferenceData, PreferenceParams> {
  // Sets the key's value: inserts the row, or replaces the value of the one
  // the caller has. `userId` was set by the data resolver.
  override async create(data: PreferenceData, params?: PreferenceParams): Promise<Preference>
  override async create(data: PreferenceData[], params?: PreferenceParams): Promise<Preference[]>
  override async create(data: PreferenceData | PreferenceData[], _params?: PreferenceParams): Promise<Preference | Preference[]> {
    if (Array.isArray(data)) throw new MethodNotAllowed('Preferences are set one at a time')
    const { userId, key, value } = data as PreferenceData & { userId: string }
    const [row] = await this.Model<Preference>('preferences')
      .insert({ userId, key, value: JSON.stringify(value) })
      .onConflict(['userId', 'key'])
      .merge({ value: JSON.stringify(value), updatedAt: this.Model.fn.now() })
      .returning('*')
    return row!
  }
}

export const PREFERENCES_PATH = 'preferences'
export const PREFERENCE_EXTERNAL_METHODS = ['find', 'get', 'create', 'remove'] as const

const validateValue = (context: HookContext) => {
  const { key, value } = context.data as PreferenceData
  const error = preferenceError(key, value)
  if (error) throw new BadRequest(error)
}

export const preferences = (app: Application) => {
  app.use(
    PREFERENCES_PATH,
    new PreferenceService({ Model: app.get('knex'), name: 'preferences', id: 'id', paginate: PAGINATE }),
    { methods: [...PREFERENCE_EXTERNAL_METHODS] }
  )

  app.service(PREFERENCES_PATH).hooks({
    around: {
      all: [schemaHooks.resolveExternal(preferenceExternalResolver), schemaHooks.resolveResult(preferenceResolver)]
    },
    before: {
      all: [schemaHooks.validateQuery(preferenceQueryValidator), schemaHooks.resolveQuery(preferenceQueryResolver)],
      create: [schemaHooks.validateData(preferenceDataValidator), validateValue, schemaHooks.resolveData(preferenceDataResolver)]
    }
  })

  // To the person's own connections, so their other tabs follow (ADR 0012).
  app.service(PREFERENCES_PATH).publish(publishTo(app, (record) => [userChannel(String(record.userId))]))
}

declare module '../../app.js' {
  interface ServiceTypes {
    [PREFERENCES_PATH]: PreferenceService
  }
}
