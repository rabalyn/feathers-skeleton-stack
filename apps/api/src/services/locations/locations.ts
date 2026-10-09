import { BadRequest, NotFound, Unavailable } from '@feathersjs/errors'
import type { Id, Params } from '@feathersjs/feathers'
import { hooks as schemaHooks } from '@feathersjs/schema'
import type { Application } from '../../app.js'
import { publishNothing } from '../../channels.js'
import { NetboxNotFound, NetboxRefused, NetboxUnavailable, type Netbox, type NetboxLocation } from '../../netbox.js'
import { PAGINATE } from '../../paginate.js'
import { limitPerUser } from '../../rate-limit.js'
import { SITE_PAGE_MAX } from '../../limits.js'
import {
  locationDataValidator,
  locationQueryValidator,
  type Location,
  type LocationData,
  type LocationPage,
  type LocationQuery
} from './locations.schema.js'

export type LocationParams = Params<LocationQuery>

export const LOCATIONS_PATH = 'locations'
export const LOCATION_EXTERNAL_METHODS = ['find', 'get', 'create'] as const

// Slugs unique in a site: NetBox requires one, nobody reads it.
const SLUG_MAX_LENGTH = 90
const SLUG_ATTEMPTS = 10

export const slugFor = (name: string): string =>
  name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH) || 'location'

export const toLocation = (location: NetboxLocation, publicUrl: string): Location => ({
  id: location.id,
  siteId: location.site.id,
  name: location.name,
  status: location.status.value,
  parent: location.parent ? { id: location.parent.id, name: location.parent.name } : null,
  netboxUrl: `${publicUrl}/dcim/locations/${location.id}/`
})

// Locations inside sites (ADR 0031): a site's rooms to pick from, resolving
// the ids records store, and adding a room NetBox does not have yet, the api's
// only write there. Reading is `locations.read`, adding `locations.create`.
export class LocationService {
  constructor(
    private readonly netbox: Netbox,
    private readonly publicUrl: string
  ) {}

  async find(params?: LocationParams): Promise<LocationPage> {
    const query = params?.query ?? {}
    const limit = Math.min(query.$limit ?? PAGINATE.default, SITE_PAGE_MAX)
    const skip = query.$skip ?? 0
    const q = query.q?.trim()
    const page = await this.call(() =>
      this.netbox.locations({ siteId: query.siteId, q: q || undefined, ids: query.id?.$in, limit, offset: skip })
    )
    return { total: page.count, limit, skip, data: page.results.map((location) => this.toLocation(location)) }
  }

  async get(id: Id, _params?: LocationParams): Promise<Location> {
    const numeric = Number(id)
    if (!Number.isInteger(numeric) || numeric < 1) throw new NotFound(`No location ${id}`)
    return this.toLocation(await this.call(() => this.netbox.location(numeric)))
  }

  // The site's location of that name, made if it has none: asking twice, or
  // two people at once, gives the same location.
  async create(data: LocationData, _params?: Params): Promise<Location> {
    const name = data.name.trim()
    const site = await this.call(() => this.netbox.site(data.siteId))
    if (site.status.value === 'retired') throw new BadRequest('The site is retired')
    const existing = await this.named(data.siteId, name)
    if (existing) return existing
    const base = slugFor(name)
    let lastRefusal: NetboxRefused | undefined
    for (let attempt = 1; attempt <= SLUG_ATTEMPTS; attempt += 1) {
      const slug = attempt === 1 ? base : `${base}-${attempt}`
      try {
        return this.toLocation(await this.call(() => this.netbox.createLocation({ site: data.siteId, name, slug })))
      } catch (error) {
        if (!(error instanceof NetboxRefused)) throw error
        lastRefusal = error
        // Made meanwhile under that name, or the slug is taken by another.
        const made = await this.named(data.siteId, name)
        if (made) return made
        // NetBox names the slug as the field or, for its uniqueness in the
        // site, in a message about the whole object.
        if (!/slug/i.test(JSON.stringify(error.reasons))) break
      }
    }
    throw new BadRequest('NetBox refused the location', { reasons: lastRefusal?.reasons })
  }

  private async named(siteId: number, name: string): Promise<Location | undefined> {
    const page = await this.call(() => this.netbox.locations({ siteId, name, limit: SITE_PAGE_MAX, offset: 0 }))
    const matches = page.results.filter((location) => location.name.toLowerCase() === name.toLowerCase())
    const found = matches.find((location) => location.parent === null) ?? matches[0]
    return found && this.toLocation(found)
  }

  private toLocation(location: NetboxLocation): Location {
    return toLocation(location, this.publicUrl)
  }

  private async call<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request()
    } catch (error) {
      if (error instanceof NetboxNotFound) throw new NotFound('No such site or location')
      if (error instanceof NetboxUnavailable) throw new Unavailable('Locations unavailable')
      throw error
    }
  }
}

export const locations = (app: Application) => {
  app.use(LOCATIONS_PATH, new LocationService(app.get('netbox'), app.get('config').netboxPublicUrl), {
    methods: [...LOCATION_EXTERNAL_METHODS]
  })
  app.service(LOCATIONS_PATH).hooks({
    // Each call is one NetBox request or a few, counted with the site lookup
    // (ADR 0010).
    around: { all: [limitPerUser('siteLookup')] },
    before: {
      find: [schemaHooks.validateQuery(locationQueryValidator)],
      create: [schemaHooks.validateData(locationDataValidator)]
    }
  })
  // NetBox is the record; nothing is pushed.
  app.service(LOCATIONS_PATH).publish(publishNothing)
}

declare module '../../app.js' {
  interface ServiceTypes {
    [LOCATIONS_PATH]: LocationService
  }
}
