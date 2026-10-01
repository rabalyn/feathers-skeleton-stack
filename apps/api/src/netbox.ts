import { readFileSync } from 'node:fs'
import { request } from 'node:https'
import type { NetboxConfig } from './config.js'

// Locations (ADR 0031): the university's sites (buildings), read from
// NetBox's REST API with a read-only v2 token, over TLS verified against the
// CA root. NetBox is the record; application records keep a site's NetBox id
// and read everything else from here, so nothing is copied.
//
// netbox-setup writes a site as: name "<key> <German designation>", facility
// the key (S1|01), physical_address "<street>\n<postal code> <city>",
// description the English designation, custom fields for the English name
// and the occupants in both languages.

export class NetboxUnavailable extends Error {}
export class NetboxNotFound extends Error {}

export interface NetboxRef {
  id: number
  name: string
  slug: string
}

export interface NetboxSite {
  id: number
  name: string
  slug: string
  status: { value: string }
  facility: string
  physical_address: string
  description: string
  region: NetboxRef | null
  group: NetboxRef | null
  custom_fields: Record<string, unknown>
}

export interface NetboxPage<T> {
  count: number
  results: T[]
}

const TIMEOUT_MS = 5000

export class Netbox {
  private readonly ca: string
  private readonly authorization: string

  constructor(private readonly config: NetboxConfig) {
    this.ca = readFileSync(config.netboxCaFile, 'utf8')
    this.authorization = `Bearer nbt_${config.netboxTokenKey}.${config.netboxToken}`
  }

  sites(query: { q?: string; limit: number; offset: number }): Promise<NetboxPage<NetboxSite>> {
    const params = new URLSearchParams({
      limit: String(query.limit),
      offset: String(query.offset),
      // Retired buildings stay for the records that reference them, but are
      // not offered for new ones.
      status__n: 'retired',
      ordering: 'facility'
    })
    if (query.q) params.set('q', query.q)
    return this.get(`/api/dcim/sites/?${params}`)
  }

  site(id: number): Promise<NetboxSite> {
    return this.get(`/api/dcim/sites/${id}/`)
  }

  // NetBox's own version, for the system-info page (ADR 0032).
  status(): Promise<{ 'netbox-version'?: string }> {
    return this.get('/api/status/')
  }

  private get<T>(path: string): Promise<T> {
    const url = new URL(path, this.config.netboxUrl)
    return new Promise<T>((resolve, reject) => {
      const req = request(
        url,
        {
          method: 'GET',
          ca: this.ca,
          minVersion: 'TLSv1.2',
          timeout: TIMEOUT_MS,
          headers: { Authorization: this.authorization, Accept: 'application/json' }
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            if (res.statusCode === 404) return reject(new NetboxNotFound(path))
            if (res.statusCode !== 200) return reject(new NetboxUnavailable(`NetBox answered ${res.statusCode}`))
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T)
            } catch {
              reject(new NetboxUnavailable('NetBox sent no JSON'))
            }
          })
          res.on('error', (error) => reject(new NetboxUnavailable(error.message)))
        }
      )
      req.on('timeout', () => req.destroy(new Error('timeout')))
      req.on('error', (error) => reject(new NetboxUnavailable(error.message)))
      req.end()
    })
  }
}
