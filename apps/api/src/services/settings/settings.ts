import { BadRequest, MethodNotAllowed, NotFound } from '@feathersjs/errors'
import { hooks as schemaHooks } from '@feathersjs/schema'
import { KnexService } from '@feathersjs/knex'
import type { Id, NullableId, Params } from '@feathersjs/feathers'
import type { Knex } from 'knex'
import type { Application } from '../../app.js'
import { recordAudit } from '../../audit.js'
import { publishTo, subjectChannel } from '../../channels.js'
import { maintenanceChanged } from '../../maintenance-mode.js'
import { PAGINATE } from '../../paginate.js'
import { CROSS_SETTING_RULES, SETTING_KEYS, isSettingKey, type SettingValues } from '../../settings/registry.js'
import { settingError } from '../../settings/store.js'
import {
  settingExternalResolver,
  settingPatchValidator,
  settingQueryResolver,
  settingQueryValidator,
  settingResolver,
  type Setting,
  type SettingPatch,
  type SettingQuery
} from './settings.schema.js'

export type SettingParams = Params<SettingQuery>

export const SETTINGS_PATH = 'settings'
// Keys are seeded by the migrate job, never created or removed through the
// API (ADR 0025).
export const SETTING_EXTERNAL_METHODS = ['find', 'get', 'patch'] as const

export interface SettingServiceOptions {
  Model: Knex
  bodySizeCeilingBytes: number
  // Called after a committed change: drops the in-process cache and acts
  // on what the change means, e.g. maintenance mode (ADR 0025).
  changed: (key: string, change: { from: unknown; to: unknown; actorId: string | null }) => void | Promise<void>
}

export class SettingService extends KnexService<Setting, SettingPatch, SettingParams, SettingPatch> {
  constructor(private readonly settingOptions: SettingServiceOptions) {
    super({ Model: settingOptions.Model, name: 'settings', id: 'key', paginate: PAGINATE })
  }

  // One key per call: validated against its own schema and, together with
  // the other current values, against the cross-setting rules. The change
  // and its audit event commit together.
  async patch(id: Id, data: SettingPatch, params?: SettingParams): Promise<Setting>
  async patch(id: null, data: SettingPatch, params?: SettingParams): Promise<Setting[]>
  async patch(id: NullableId, data: SettingPatch, params?: SettingParams): Promise<Setting | Setting[]>
  async patch(id: NullableId, data: SettingPatch, params?: SettingParams): Promise<Setting | Setting[]> {
    if (id === null) throw new MethodNotAllowed('Settings are changed one key at a time')
    const key = String(id)
    if (!isSettingKey(key)) throw new NotFound(`No record found for id '${key}'`)

    const error = settingError(key, data.value)
    if (error) throw new BadRequest('Invalid setting value', { errors: [{ key, message: error }] })

    const knex = this.settingOptions.Model
    const actorId = params?.user?.id ?? null
    const from = await knex.transaction(async (trx) => {
      // Serialises concurrent writers, so two changes that are each valid
      // cannot together break a cross-setting rule.
      const rows: { key: string; value: unknown }[] = await trx('settings')
        .whereIn('key', SETTING_KEYS)
        .forUpdate()
        .select('key', 'value')
      const current = rows.find((row) => row.key === key)
      if (!current) throw new NotFound(`No record found for id '${key}'`)

      const values = Object.fromEntries(rows.map((row) => [row.key, row.value])) as Partial<SettingValues>
      const next = { ...values, [key]: data.value }
      const violations = CROSS_SETTING_RULES.map((rule) =>
        rule({ values: next, bodySizeCeilingBytes: this.settingOptions.bodySizeCeilingBytes })
      ).filter((message): message is string => message !== undefined)
      if (violations.length > 0) {
        throw new BadRequest('Settings would conflict', { errors: violations.map((message) => ({ key, message })) })
      }

      await trx('settings')
        .where({ key })
        .update({ value: JSON.stringify(data.value), updatedAt: trx.fn.now(), updatedBy: actorId })
      await recordAudit(trx, {
        actorId,
        action: 'settings.update',
        resourceType: SETTINGS_PATH,
        resourceId: key,
        detail: { from: current.value, to: data.value }
      })
      return current.value
    })
    await this.settingOptions.changed(key, { from, to: data.value, actorId })
    return this._get(key, { ...params, query: {} })
  }
}

export const settings = (app: Application) => {
  app.use(
    SETTINGS_PATH,
    new SettingService({
      Model: app.get('knex'),
      bodySizeCeilingBytes: app.get('config').bodySizeCeilingBytes,
      changed: async (key, change) => {
        app.get('settings').forget(isSettingKey(key) ? key : undefined)
        if (key === 'maintenanceMode') await maintenanceChanged(app, change)
      }
    }),
    { methods: [...SETTING_EXTERNAL_METHODS] }
  )

  app.service(SETTINGS_PATH).hooks({
    around: {
      all: [schemaHooks.resolveExternal(settingExternalResolver), schemaHooks.resolveResult(settingResolver)]
    },
    before: {
      all: [schemaHooks.validateQuery(settingQueryValidator), schemaHooks.resolveQuery(settingQueryResolver)],
      patch: [schemaHooks.validateData(settingPatchValidator)]
    }
  })

  // To whoever may read the settings (ADR 0011, 0012).
  app.service(SETTINGS_PATH).publish(publishTo(app, () => [subjectChannel(SETTINGS_PATH)]))
}

declare module '../../app.js' {
  interface ServiceTypes {
    [SETTINGS_PATH]: SettingService
  }
}
