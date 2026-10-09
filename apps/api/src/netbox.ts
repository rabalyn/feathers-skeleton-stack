import { readFileSync } from 'node:fs'
import { request } from 'node:https'
import type { NetboxConfig } from './config.js'

// Locations (ADR 0031): the university's sites (buildings) and the
// locations (rooms) inside them, from NetBox's REST API with a v2 token whose
// only write is adding locations, over TLS verified against the CA root.
// NetBox is the record; application records keep a site's or a location's
// NetBox id and read everything else from here, so nothing is copied.
//
// netbox-setup writes a site as: name "<key> <German designation>", facility
// the key (S1|01), physical_address "<street>\n<postal code> <city>",
// description the English designation, custom fields for the English name
// and the occupants in both languages.

export class NetboxUnavailable extends Error {}
export class NetboxNotFound extends Error {}
// NetBox refused what was sent (400), with its reasons per field.
export class NetboxRefused extends Error {
  constructor(readonly reasons: Record<string, unknown>) {
    super('NetBox refused the request')
  }
}

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

export interface NetboxLocation {
  id: number
  name: string
  slug: string
  status: { value: string }
  site: NetboxRef
  parent: NetboxRef | null
  description: string
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

  // By search, or by the ids records store: retired buildings stay for the
  // records that reference them, but are not offered for new ones.
  sites(query: { q?: string; ids?: number[]; limit: number; offset: number }): Promise<NetboxPage<NetboxSite>> {
    const params = new URLSearchParams({ limit: String(query.limit), offset: String(query.offset), ordering: 'facility' })
    if (query.ids) for (const id of query.ids) params.append('id', String(id))
    else params.set('status__n', 'retired')
    if (query.q) params.set('q', query.q)
    return this.get(`/api/dcim/sites/?${params}`)
  }

  site(id: number): Promise<NetboxSite> {
    return this.get(`/api/dcim/sites/${id}/`)
  }

  // A site's locations, or those of the ids records store; retired ones
  // only by id, as with sites. `name` matches exactly, regardless of case.
  locations(query: {
    siteId?: number
    q?: string
    name?: string
    ids?: number[]
    limit: number
    offset: number
  }): Promise<NetboxPage<NetboxLocation>> {
    const params = new URLSearchParams({ limit: String(query.limit), offset: String(query.offset), ordering: 'name' })
    if (query.ids) for (const id of query.ids) params.append('id', String(id))
    else params.set('status__n', 'retired')
    if (query.siteId !== undefined) params.set('site_id', String(query.siteId))
    if (query.q) params.set('q', query.q)
    if (query.name !== undefined) params.set('name__ie', query.name)
    return this.get(`/api/dcim/locations/?${params}`)
  }

  location(id: number): Promise<NetboxLocation> {
    return this.get(`/api/dcim/locations/${id}/`)
  }

  createLocation(data: { site: number; name: string; slug: string }): Promise<NetboxLocation> {
    return this.send('POST', '/api/dcim/locations/', { ...data, status: 'active' })
  }

  // NetBox's own version, for the system-info page (ADR 0032).
  status(): Promise<{ 'netbox-version'?: string }> {
    return this.get('/api/status/')
  }

  private get<T>(path: string): Promise<T> {
    return this.send('GET', path)
  }

  private send<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const url = new URL(path, this.config.netboxUrl)
    const payload = body === undefined ? undefined : JSON.stringify(body)
    return new Promise<T>((resolve, reject) => {
      const req = request(
        url,
        {
          method,
          ca: this.ca,
          minVersion: 'TLSv1.2',
          timeout: TIMEOUT_MS,
          headers: {
            Authorization: this.authorization,
            Accept: 'application/json',
            ...(payload === undefined ? {} : { 'Content-Type': 'application/json' })
          }
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            if (res.statusCode === 404) return reject(new NetboxNotFound(path))
            let parsed: unknown
            try {
              parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            } catch {
              return reject(new NetboxUnavailable(`NetBox answered ${res.statusCode} without JSON`))
            }
            if (res.statusCode === 400 && parsed && typeof parsed === 'object') {
              return reject(new NetboxRefused(parsed as Record<string, unknown>))
            }
            if (res.statusCode !== 200 && res.statusCode !== 201) {
              return reject(new NetboxUnavailable(`NetBox answered ${res.statusCode}`))
            }
            resolve(parsed as T)
          })
          res.on('error', (error) => reject(new NetboxUnavailable(error.message)))
        }
      )
      req.on('timeout', () => req.destroy(new Error('timeout')))
      req.on('error', (error) => reject(new NetboxUnavailable(error.message)))
      req.end(payload)
    })
  }
}
