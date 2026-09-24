import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.js'

describe('loadConfig', () => {
  it('applies defaults and coerces ports', async () => {
    const config = await loadConfig({ PUBLIC_ORIGIN: 'https://app.localhost:8443', PORT: '4000' })
    expect(config).toEqual({
      publicOrigin: 'https://app.localhost:8443',
      port: 4000,
      internalPort: 9090,
      logLevel: 'info'
    })
  })

  it('refuses missing required values', async () => {
    await expect(loadConfig({})).rejects.toThrow(/PUBLIC_ORIGIN/)
  })

  it('refuses a plain-http origin', async () => {
    await expect(loadConfig({ PUBLIC_ORIGIN: 'http://app.localhost' })).rejects.toThrow(/PUBLIC_ORIGIN/)
  })

  it('refuses a non-numeric port', async () => {
    await expect(loadConfig({ PUBLIC_ORIGIN: 'https://app.localhost', PORT: 'x' })).rejects.toThrow(/PORT/)
  })
})
