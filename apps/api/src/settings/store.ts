import { Ajv } from '@feathersjs/schema'
import type { Knex } from 'knex'
import { SETTINGS, SETTING_KEYS, type SettingKey, type SettingValues } from './registry.js'

// Reads runtime settings (ADR 0025) with a short in-process cache, so an
// admin's change takes effect within CACHE_TTL_MS without a restart.

export const CACHE_TTL_MS = 30_000

const ajv = new Ajv({ allErrors: true })
const validators = new Map(SETTING_KEYS.map((key) => [key, ajv.compile(SETTINGS[key].schema)]))

export class SettingsError extends Error {}

// Checks a value against its key's schema; returns the error text, if any.
export const settingError = (key: SettingKey, value: unknown): string | undefined => {
  const validate = validators.get(key)
  if (!validate || validate(value)) return undefined
  return ajv.errorsText(validate.errors, { dataVar: key })
}

// Inserts every registered key that is missing, with its default, and never
// touches an existing value. Run by the migrate job after the migrations.
// Takes a Knex in database names.
export const seedSettings = async (knex: Knex): Promise<SettingKey[]> => {
  const rows = SETTING_KEYS.map((key) => ({ key, value: JSON.stringify(SETTINGS[key].default) }))
  const inserted: { key: SettingKey }[] = await knex('settings')
    .insert(rows)
    .onConflict('key')
    .ignore()
    .returning('key')
  return inserted.map((row) => row.key)
}

export class SettingsStore {
  private cache = new Map<SettingKey, { value: unknown; expires: number }>()

  constructor(
    private readonly knex: Knex,
    private readonly ttlMs = CACHE_TTL_MS
  ) {}

  async get<K extends SettingKey>(key: K): Promise<SettingValues[K]> {
    const cached = this.cache.get(key)
    if (cached && cached.expires > Date.now()) return cached.value as SettingValues[K]

    const row = await this.knex<{ key: string; value: unknown }>('settings').where({ key }).first('value')
    if (!row) throw new SettingsError(`runtime setting ${key} is missing`)
    const error = settingError(key, row.value)
    if (error) throw new SettingsError(`runtime setting ${key} is invalid: ${error}`)
    this.cache.set(key, { value: row.value, expires: Date.now() + this.ttlMs })
    return row.value as SettingValues[K]
  }

  // The refuse-to-start check: every key must exist and be valid.
  async assertPresent(keys: readonly SettingKey[]): Promise<void> {
    const problems: string[] = []
    for (const key of keys) {
      try {
        await this.get(key)
      } catch (error) {
        if (!(error instanceof SettingsError)) throw error
        problems.push(error.message)
      }
    }
    if (problems.length > 0) throw new SettingsError(`Invalid runtime settings:\n  ${problems.join('\n  ')}`)
  }

  forget(key?: SettingKey): void {
    if (key) this.cache.delete(key)
    else this.cache.clear()
  }
}
