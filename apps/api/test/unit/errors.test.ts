import { BadRequest, Conflict, GeneralError, NotAuthenticated, NotFound } from '@feathersjs/errors'
import { ERROR } from '@feathersjs/knex'
import type { HookContext } from '../../src/declarations.js'
import { pino } from 'pino'
import { describe, expect, it } from 'vitest'
import { rejectBody, sanitizeHttpErrors, sanitizeServiceErrors } from '../../src/hooks/errors.js'

const logger = () => pino({ level: 'silent' })
const leak = () => Promise.reject(new Error('relation "saml_requests" does not exist'))

describe('service errors', () => {
  const hook = sanitizeServiceErrors(logger)
  const context = (provider?: string) => ({ path: 'x', method: 'find', params: { provider } }) as unknown as HookContext

  it('answers an unexpected error generically to external callers', async () => {
    const error = await hook(context('rest'), leak).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GeneralError)
    expect((error as Error).message).toBe('Internal error')
  })

  it('passes expected client errors through', async () => {
    await expect(hook(context('rest'), () => Promise.reject(new NotFound('No record')))).rejects.toThrow('No record')
    await expect(hook(context('socketio'), () => Promise.reject(new BadRequest('Invalid')))).rejects.toThrow('Invalid')
  })

  // Decided 2026-10-02 (ADR 0018): no library's detail reaches a client.
  it('names only the fields a schema refused, never the rule', async () => {
    const ajv = new BadRequest('validation failed', [
      { instancePath: '/title', schemaPath: '#/properties/title/maxLength', keyword: 'maxLength', params: { limit: 200 }, message: 'must NOT have more than 200 characters' },
      { instancePath: '', schemaPath: '#/additionalProperties', keyword: 'additionalProperties', params: { additionalProperty: 'ownerId' } },
      { instancePath: '', schemaPath: '#/required', keyword: 'required', params: { missingProperty: 'fileId' } },
      { instancePath: '/$select/1', schemaPath: '#/properties/%24select/items/enum', keyword: 'enum', params: { allowedValues: ['id', 'title'] } }
    ])
    const error = (await hook(context('rest'), () => Promise.reject(ajv)).catch((e: unknown) => e)) as BadRequest
    expect(error).toBeInstanceOf(BadRequest)
    expect(error.toJSON()).toEqual({
      name: 'BadRequest',
      message: 'Invalid data',
      code: 400,
      className: 'bad-request',
      data: {},
      errors: [{ field: 'title' }, { field: 'ownerId' }, { field: 'fileId' }, { field: '$select.1' }]
    })
    expect(JSON.stringify(error.toJSON())).not.toMatch(/schemaPath|allowedValues|maxLength|200/)
  })

  it("answers a 401 in the application's own words only", async () => {
    const jwt = new NotAuthenticated('jwt malformed', { name: 'JsonWebTokenError' })
    const error = (await hook(context('socketio'), () => Promise.reject(jwt)).catch((e: unknown) => e)) as NotAuthenticated
    expect(error.toJSON()).toEqual({ name: 'NotAuthenticated', message: 'Not authenticated', code: 401, className: 'not-authenticated' })
    await expect(hook(context('rest'), () => Promise.reject(new NotAuthenticated('Invalid login')))).rejects.toThrow('Invalid login')
  })

  it("drops the database's wording from an error the adapter made a 4xx", async () => {
    const conflict = Object.assign(new Conflict('duplicate key value violates unique constraint "users_email_key"'), { [ERROR]: {} })
    const error = (await hook(context('rest'), () => Promise.reject(conflict)).catch((e: unknown) => e)) as Conflict
    expect(error.toJSON()).toEqual({ name: 'Conflict', message: 'Conflict', code: 409, className: 'conflict' })
  })

  it('keeps the real error for internal callers', async () => {
    await expect(hook(context(undefined), leak)).rejects.toThrow(/saml_requests/)
  })
})

describe('HTTP route errors', () => {
  const middleware = sanitizeHttpErrors(logger)
  const ctx = { method: 'GET', path: '/auth/saml/login' } as never

  it('answers an unexpected error generically', async () => {
    const error = await middleware(ctx, leak).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GeneralError)
    expect((error as Error).message).toBe('Internal error')
  })

  it('passes expected client errors through', async () => {
    await expect(middleware(ctx, () => Promise.reject(new NotFound('No record')))).rejects.toThrow('No record')
  })
})

describe('body parser errors', () => {
  it("answers a body the parser refused as the client's error, without the parser's words", () => {
    const malformed = new SyntaxError("Expected property name or '}' in JSON at position 1")
    expect(() => rejectBody(malformed)).toThrow(expect.objectContaining({ code: 400, message: 'Invalid request body' }))
    const tooLarge = Object.assign(new Error('request entity too large'), { status: 413, expose: true })
    expect(() => rejectBody(tooLarge)).toThrow(expect.objectContaining({ code: 413, message: 'Request body too large' }))
  })
})
