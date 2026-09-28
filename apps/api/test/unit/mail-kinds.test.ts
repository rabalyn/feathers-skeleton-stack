import { Type } from '@feathersjs/typebox'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../src/locales.js'
import { MailKindError, defineMailKind, templateVariables } from '../../src/mail/kind.js'
import { MAIL_KINDS } from '../../src/mail/registry.js'
import { dataValidator } from '../../src/validators.js'

const ajv = dataValidator

const notification = {
  key: 'test.kind',
  type: 'notification' as const,
  params: Type.Object({}),
  variables: Type.Object({}),
  build: async () => ({}),
  sample: {},
  defaults: { de: { subject: 's', body: 'b' }, en: { subject: 's', body: 'b' } }
}

describe('registered mail kinds', () => {
  it.each(MAIL_KINDS.map((kind) => [kind.key, kind] as const))('%s is complete', (_key, kind) => {
    // The sample is what previews and the check on save render against.
    expect(ajv.validate(kind.variables, kind.sample), ajv.errorsText()).toBe(true)
    expect(Object.keys(kind.defaults).sort()).toEqual([...LOCALES].sort())
    if (kind.type === 'campaign') expect(kind.recipients).toBeTypeOf('function')
    expect(Object.keys(templateVariables(kind).properties)).toEqual(expect.arrayContaining(['recipient', 'app']))
  })
})

describe('defineMailKind', () => {
  it('refuses a key without an area', () => {
    expect(() => defineMailKind({ ...notification, key: 'kind' })).toThrow(MailKindError)
  })

  it('refuses variables the skeleton adds', () => {
    expect(() => defineMailKind({ ...notification, variables: Type.Object({ recipient: Type.String() }) } as never)).toThrow(
      /recipient/
    )
  })

  it('accepts only form fields as campaign parameters', () => {
    const campaign = { ...notification, type: 'campaign' as const, recipients: () => ({}) as never }
    expect(() =>
      defineMailKind({
        ...campaign,
        params: Type.Object({
          text: Type.String(),
          count: Type.Integer(),
          on: Type.String({ format: 'date' }),
          flag: Type.Boolean(),
          choice: Type.Union([Type.Literal('a'), Type.Literal('b')])
        })
      })
    ).not.toThrow()
    expect(() => defineMailKind({ ...campaign, params: Type.Object({ ids: Type.Array(Type.String()) }) })).toThrow(/ids/)
  })
})
