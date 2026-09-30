import { NotFound, Unavailable } from '@feathersjs/errors'
import type { Id, Params } from '@feathersjs/feathers'
import { hooks as schemaHooks } from '@feathersjs/schema'
import type { Application } from '../../app.js'
import { publishNothing } from '../../channels.js'
import { NetboxNotFound, NetboxUnavailable, type Netbox, type NetboxSite } from '../../netbox.js'
import { PAGINATE } from '../../paginate.js'
import { SITE_PAGE_MAX, siteQueryValidator, type Site, type SitePage, type SiteQuery } from './sites.schema.js'

export type SiteParams = Params<SiteQuery>

export const SITES_PATH = 'sites'
export const SITE_EXTERNAL_METHODS = ['find', 'get'] as const

const POSTAL_LINE = /^(\d{5})\s+(.+)$/

const lines = (value: unknown): string[] =>
  typeof value === 'string' ? value.split('\n').map((line) => line.trim()).filter(Boolean) : []

const orNull = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null)

// NetBox's site as netbox-setup writes it (ADR 0031), in this API's shape.
export const toSite = (site: NetboxSite, publicUrl: string): Site => {
  const [street = null, cityLine = ''] = lines(site.physical_address)
  const postal = POSTAL_LINE.exec(cityLine)
  const prefix = `${site.facility} `
  return {
    id: site.id,
    key: site.facility,
    name: site.name.startsWith(prefix) ? site.name.slice(prefix.length) : site.name,
    nameEn: orNull(site.custom_fields.name_en),
    status: site.status.value,
    group: site.group ? { id: site.group.id, key: site.group.name.split(' ')[0] ?? site.group.slug, name: site.group.name } : null,
    street,
    postalCode: postal?.[1] ?? null,
    city: postal?.[2] ?? orNull(cityLine),
    occupants: { de: lines(site.custom_fields.occupants_de), en: lines(site.custom_fields.occupants_en) },
    netboxUrl: `${publicUrl}/dcim/sites/${site.id}/`
  }
}

// Read only (ADR 0031): the address lookup, and resolving the NetBox id an
// application record stores. Every signed-in person may read (ADR 0011).
export class SiteService {
  constructor(
    private readonly netbox: Netbox,
    private readonly publicUrl: string
  ) {}

  async find(params?: SiteParams): Promise<SitePage> {
    const query = params?.query ?? {}
    const limit = Math.min(query.$limit ?? PAGINATE.default, SITE_PAGE_MAX)
    const skip = query.$skip ?? 0
    const q = query.q?.trim()
    const page = await this.call(() => this.netbox.sites({ q: q || undefined, limit, offset: skip }))
    return { total: page.count, limit, skip, data: page.results.map((site) => toSite(site, this.publicUrl)) }
  }

  async get(id: Id, _params?: SiteParams): Promise<Site> {
    const numeric = Number(id)
    if (!Number.isInteger(numeric) || numeric < 1) throw new NotFound(`No site ${id}`)
    return toSite(await this.call(() => this.netbox.site(numeric)), this.publicUrl)
  }

  private async call<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request()
    } catch (error) {
      if (error instanceof NetboxNotFound) throw new NotFound('No such site')
      if (error instanceof NetboxUnavailable) throw new Unavailable('Locations unavailable')
      throw error
    }
  }
}

export const sites = (app: Application) => {
  app.use(SITES_PATH, new SiteService(app.get('netbox'), app.get('config').netboxPublicUrl), {
    methods: [...SITE_EXTERNAL_METHODS]
  })
  app.service(SITES_PATH).hooks({
    before: { find: [schemaHooks.validateQuery(siteQueryValidator)] }
  })
  // Read only.
  app.service(SITES_PATH).publish(publishNothing)
}

declare module '../../app.js' {
  interface ServiceTypes {
    [SITES_PATH]: SiteService
  }
}
