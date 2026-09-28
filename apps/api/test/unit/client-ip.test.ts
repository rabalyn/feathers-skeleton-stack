import { describe, expect, it } from 'vitest'
import { TrustedProxy, normalizeIp } from '../../src/client-ip.js'

// ADR 0010, 0016: X-Forwarded-For counts only when Nginx sent it.

const proxy = (addresses: string[] | Error) =>
  new TrustedProxy('nginx', async () => {
    if (addresses instanceof Error) throw addresses
    return addresses
  })

describe('client address', () => {
  it('takes the forwarded address from the proxy', async () => {
    expect(await proxy(['10.89.0.5']).clientIp('10.89.0.5', '198.51.100.7')).toBe('198.51.100.7')
  })

  it('treats an IPv4-mapped peer like its IPv4 address', async () => {
    expect(await proxy(['10.89.0.5']).clientIp('::ffff:10.89.0.5', '198.51.100.7')).toBe('198.51.100.7')
  })

  it('ignores the header from anyone else', async () => {
    expect(await proxy(['10.89.0.5']).clientIp('10.89.0.9', '198.51.100.7')).toBe('10.89.0.9')
  })

  it('trusts nobody when the proxy name does not resolve', async () => {
    expect(await proxy(new Error('ENOTFOUND')).clientIp('10.89.0.5', '198.51.100.7')).toBe('10.89.0.5')
  })

  it('uses the last entry, the one the proxy added, and rejects garbage', async () => {
    const p = proxy(['10.89.0.5'])
    expect(await p.clientIp('10.89.0.5', '1.2.3.4, 198.51.100.7')).toBe('198.51.100.7')
    expect(await p.clientIp('10.89.0.5', 'not-an-ip')).toBe('10.89.0.5')
    expect(await p.clientIp('10.89.0.5', undefined)).toBe('10.89.0.5')
  })

  it('normalises addresses', () => {
    expect(normalizeIp('::ffff:192.0.2.1')).toBe('192.0.2.1')
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1')
    expect(normalizeIp('nope')).toBeUndefined()
  })
})
