import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

// The client address (ADR 0010, 0016). Nginx replaces X-Forwarded-For with
// the address it saw; the header is believed only when the connection comes
// from Nginx itself, recognised by resolving its container name. Anything
// else connecting directly is keyed by its own address, whatever it claims.

const RESOLVE_TTL_MS = 30_000

// "::ffff:10.0.0.1" and "10.0.0.1" are the same peer.
export const normalizeIp = (address: string | undefined): string | undefined => {
  if (!address) return undefined
  const plain = address.startsWith('::ffff:') && isIP(address.slice(7)) === 4 ? address.slice(7) : address
  return isIP(plain) ? plain : undefined
}

export class TrustedProxy {
  private addresses: Set<string> = new Set()
  private expires = 0
  private pending: Promise<void> | undefined

  constructor(
    private readonly host: string,
    private readonly resolve: (host: string) => Promise<string[]> = async (name) =>
      (await lookup(name, { all: true })).map((entry) => entry.address)
  ) {}

  private async refresh(): Promise<void> {
    try {
      const resolved = await this.resolve(this.host)
      this.addresses = new Set(resolved.map(normalizeIp).filter((a): a is string => a !== undefined))
    } catch {
      // Not resolvable (not running, or not on this network): trust nobody.
      this.addresses = new Set()
    }
    this.expires = Date.now() + RESOLVE_TTL_MS
  }

  async isProxy(peer: string): Promise<boolean> {
    if (Date.now() >= this.expires) {
      this.pending ??= this.refresh().finally(() => (this.pending = undefined))
      await this.pending
    }
    return this.addresses.has(peer)
  }

  // The client address for a connection from `peer` carrying `forwardedFor`.
  async clientIp(peer: string | undefined, forwardedFor: string | string[] | undefined): Promise<string> {
    const direct = normalizeIp(peer) ?? 'unknown'
    if (direct === 'unknown' || !(await this.isProxy(direct))) return direct
    const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor
    // Nginx sets a single address; the last entry is the one it added.
    const last = header?.split(',').pop()?.trim()
    return normalizeIp(last) ?? direct
  }
}
