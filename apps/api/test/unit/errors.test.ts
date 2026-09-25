import { BadRequest, GeneralError, NotFound } from '@feathersjs/errors'
import type { HookContext } from '@feathersjs/feathers'
import { pino } from 'pino'
import { describe, expect, it } from 'vitest'
import { sanitizeHttpErrors, sanitizeServiceErrors } from '../../src/hooks/errors.js'

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
