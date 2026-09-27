import { describe, expect, it } from 'vitest'
import { isConnectionError } from '../../src/jobs/maintenance.js'

const failure = (message: string, code?: string) => Object.assign(new Error(message), { code })

describe('worker errors', () => {
  it('counts a lost Valkey connection as transient', () => {
    expect(isConnectionError(failure('getaddrinfo ENOTFOUND valkey', 'ENOTFOUND'))).toBe(true)
    expect(isConnectionError(failure('connect ECONNREFUSED 10.89.0.5:6379', 'ECONNREFUSED'))).toBe(true)
    const exhausted = Object.defineProperty(new Error('Reached the max retries per request limit (which is 20).'), 'name', {
      value: 'MaxRetriesPerRequestError'
    })
    expect(isConnectionError(exhausted)).toBe(true)
  })

  it('keeps every other error at error', () => {
    expect(isConnectionError(failure('NOPERM this user has no permissions'))).toBe(false)
    expect(isConnectionError(failure('boom', 'ERR_SOMETHING'))).toBe(false)
  })
})
