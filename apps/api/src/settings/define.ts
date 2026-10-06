import type { Static, TSchema } from '@feathersjs/typebox'

// One runtime setting (ADR 0025): the schema of its value, and its default.
// Apart from registry.ts so that the product's settings (product/settings.ts,
// ADR 0035) can use it without importing the module that imports them.
export interface SettingDefinition<S extends TSchema = TSchema> {
  schema: S
  default: Static<S>
}

export const define = <S extends TSchema>(schema: S, defaultValue: Static<S>): SettingDefinition<S> => ({ schema, default: defaultValue })
