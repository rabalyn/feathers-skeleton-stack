import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.js'

const secretFile = (value: string) => {
  const path = join(mkdtempSync(join(tmpdir(), 'config-')), 'secret')
  writeFileSync(path, value)
  return path
}

const base = () => ({
  PUBLIC_ORIGIN: 'https://app.localhost:8443',
  AUTH_SIGNING_SECRET_FILE: secretFile(`${'s'.repeat(40)}\n`)
})

describe('loadConfig', () => {
  it('applies defaults and coerces ports', async () => {
    const config = await loadConfig({ ...base(), PORT: '4000' })
    expect(config).toEqual({
      publicOrigin: 'https://app.localhost:8443',
      authSigningSecret: 's'.repeat(40),
      port: 4000,
      internalPort: 9090,
      logLevel: 'info'
    })
  })

  it('refuses missing required values', async () => {
    await expect(loadConfig({})).rejects.toThrow(/PUBLIC_ORIGIN/)
  })

  it('refuses a plain-http origin', async () => {
    await expect(loadConfig({ ...base(), PUBLIC_ORIGIN: 'http://app.localhost' })).rejects.toThrow(/PUBLIC_ORIGIN/)
  })

  it('refuses a non-numeric port', async () => {
    await expect(loadConfig({ ...base(), PORT: 'x' })).rejects.toThrow(/PORT/)
  })

  it('reads secrets only from *_FILE, never from the plain variable', async () => {
    const { AUTH_SIGNING_SECRET_FILE: _unused, ...env } = base()
    await expect(loadConfig({ ...env, AUTH_SIGNING_SECRET: 'x'.repeat(40) })).rejects.toThrow(
      /AUTH_SIGNING_SECRET_FILE/
    )
  })

  it('reports an unreadable secret file', async () => {
    await expect(loadConfig({ ...base(), AUTH_SIGNING_SECRET_FILE: '/nonexistent' })).rejects.toThrow(
      /AUTH_SIGNING_SECRET_FILE: cannot read/
    )
  })

  it('keeps multi-line secret content apart from one trailing newline', async () => {
    const pem = `-----BEGIN X-----\n${'a'.repeat(40)}\n-----END X-----\n`
    const config = await loadConfig({ ...base(), AUTH_SIGNING_SECRET_FILE: secretFile(pem) })
    expect(config.authSigningSecret).toBe(pem.slice(0, -1))
  })
})
