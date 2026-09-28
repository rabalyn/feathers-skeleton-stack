import { Ajv, addFormats, type FormatsPluginOptions } from '@feathersjs/schema'

// ADR 0005: one validator for data, one for REST query strings (with type
// coercion, so ?$limit=10 is a number).

const formats: FormatsPluginOptions = ['date', 'date-time', 'email', 'uuid']

export const dataValidator: Ajv = addFormats(new Ajv({ allErrors: true }), formats)

export const queryValidator: Ajv = addFormats(
  new Ajv({ allErrors: true, coerceTypes: true }),
  formats
)
