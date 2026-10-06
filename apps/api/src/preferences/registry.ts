import { Ajv } from '@feathersjs/schema'
import { Type, type Static } from '@feathersjs/typebox'
import { PRODUCT_PREFERENCES } from '../product/preferences.js'

// Personal preferences (decided 2026-10-02, ADR 0014): the one registry of
// every key and the schema of its value, as runtime settings have theirs
// (ADR 0025). A key has no default here: a person without a row gets
// whatever the web app does without one. A product adds its keys in
// product/preferences.ts (ADR 0035); a key is stable once released, since
// rows store it.

const SKELETON_PREFERENCES = {
  // The order of the navigation drawer, as route names. Names the web app no
  // longer knows, or the person may no longer open, are skipped there.
  navOrder: Type.Array(Type.String({ pattern: '^[a-z][a-z0-9-]*$', maxLength: 64 }), { maxItems: 100, uniqueItems: true })
}

// A product's key never replaces one of the skeleton's.
const clashes = Object.keys(PRODUCT_PREFERENCES).filter((key) => Object.hasOwn(SKELETON_PREFERENCES, key))
if (clashes.length) throw new Error(`preferences: the product redefines ${clashes.join(', ')}`)

export const PREFERENCES = { ...SKELETON_PREFERENCES, ...PRODUCT_PREFERENCES }

export type PreferenceKey = keyof typeof PREFERENCES
export type PreferenceValues = { [K in PreferenceKey]: Static<(typeof PREFERENCES)[K]> }

export const PREFERENCE_KEYS = Object.keys(PREFERENCES) as PreferenceKey[]

const ajv = new Ajv({ allErrors: true })
const validators = new Map(PREFERENCE_KEYS.map((key) => [key, ajv.compile(PREFERENCES[key])]))

// Checks a value against its key's schema; returns the error text, if any.
export const preferenceError = (key: PreferenceKey, value: unknown): string | undefined => {
  const validate = validators.get(key)
  if (!validate || validate(value)) return undefined
  return ajv.errorsText(validate.errors, { dataVar: key })
}
