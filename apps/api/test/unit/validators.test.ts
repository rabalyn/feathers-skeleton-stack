import { Type } from '@feathersjs/typebox'
import { describe, expect, it } from 'vitest'
import { compileValidators, dataValidator, lazyValidator } from '../../src/validators.js'

// ADR 0005: service validators compile on their first call, and
// compileValidators compiles the rest.

describe('lazyValidator', () => {
  it('compiles on the first call or in compileValidators, once', async () => {
    const validate = lazyValidator(Type.Object({ name: Type.String() }, { $id: 'LazyOnce', additionalProperties: false }), dataValidator)
    expect(dataValidator.getSchema('LazyOnce')).toBeUndefined()
    await expect(validate({ name: 'a' })).resolves.toEqual({ name: 'a' })
    expect(dataValidator.getSchema('LazyOnce')).toBeDefined()
    await expect(validate({ name: 'a', extra: 1 })).rejects.toThrow()
    // Compiled already: nothing left to do, and no second compile of the $id.
    expect(compileValidators()).toBe(0)
  })

  it('lets compileValidators find a schema AJV refuses before any call', () => {
    lazyValidator(Type.Object({ site: Type.String({ format: 'uri' }) }, { $id: 'LazyRefused' }), dataValidator)
    expect(() => compileValidators()).toThrow(/unknown format "uri"/)
  })
})
