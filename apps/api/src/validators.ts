import { Ajv, addFormats, type FormatsPluginOptions, type Validator } from '@feathersjs/schema'
import { getValidator } from '@feathersjs/typebox'

// ADR 0005: one validator for data, one for REST query strings (with type
// coercion, so ?$limit=10 is a number).

const formats: FormatsPluginOptions = ['date', 'date-time', 'email', 'uuid']

export const dataValidator: Ajv = addFormats(new Ajv({ allErrors: true }), formats)

export const queryValidator: Ajv = addFormats(
  new Ajv({ allErrors: true, coerceTypes: true }),
  formats
)

// ADR 0005: a service's validator is compiled on its first call, not when
// its module is imported. Compiling one takes tens of milliseconds and a
// service has about four, which every start, worker and test file
// importing the services paid for, whether it validated anything or not.
const uncompiled = new Set<() => void>()

export const lazyValidator = <T = unknown, R = T>(schema: Parameters<typeof getValidator>[0], ajv: Ajv): Validator<T, R> => {
  let validate: Validator<T, R> | undefined
  const compile = () => {
    validate ??= getValidator<T, R>(schema, ajv)
    uncompiled.delete(compile)
    return validate
  }
  uncompiled.add(compile)
  return (data) => compile()(data)
}

// Compiles every lazy validator made so far, so a schema AJV refuses (an
// unknown format, say) fails a test rather than its first request. Returns
// how many it compiled.
export const compileValidators = () => {
  const pending = [...uncompiled]
  for (const compile of pending) compile()
  return pending.length
}
