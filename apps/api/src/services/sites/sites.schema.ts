import { Type, getValidator, type Static } from '@feathersjs/typebox'
import { SITE_PAGE_MAX, SITE_SEARCH_MAX_LENGTH } from '../../limits.js'
import { queryValidator } from '../../validators.js'

// Locations (ADR 0031). A site is a building of the university as NetBox
// holds it; `id` is NetBox's, which application records store to reference
// it. Sites are not records of this application: nothing here is written.

export { SITE_PAGE_MAX, SITE_SEARCH_MAX_LENGTH } from '../../limits.js'

const text = Type.Union([Type.String(), Type.Null()])

export const siteGroupSchema = Type.Object(
  { id: Type.Integer(), key: Type.String(), name: Type.String() },
  { $id: 'SiteGroup', additionalProperties: false }
)
export type SiteGroup = Static<typeof siteGroupSchema>

export const siteSchema = Type.Object(
  {
    id: Type.Integer(),
    // The university's building key, e.g. S1|01.
    key: Type.String(),
    name: Type.String(),
    nameEn: text,
    status: Type.String(),
    // Campus section, e.g. S1 – Abschnitt Stadtmitte Mitte.
    group: Type.Union([siteGroupSchema, Type.Null()]),
    street: text,
    postalCode: text,
    city: text,
    occupants: Type.Object({ de: Type.Array(Type.String()), en: Type.Array(Type.String()) }, { additionalProperties: false }),
    // The site in NetBox's web UI, for people with access there.
    netboxUrl: Type.String()
  },
  { $id: 'Site', additionalProperties: false }
)
export type Site = Static<typeof siteSchema>

export interface SitePage {
  total: number
  limit: number
  skip: number
  data: Site[]
}

export const siteQuerySchema = Type.Object(
  {
    // Words matched against key, name, address and description by NetBox.
    q: Type.Optional(Type.String({ maxLength: SITE_SEARCH_MAX_LENGTH })),
    $limit: Type.Optional(Type.Integer({ minimum: 0, maximum: SITE_PAGE_MAX })),
    $skip: Type.Optional(Type.Integer({ minimum: 0 }))
  },
  { $id: 'SiteQuery', additionalProperties: false }
)
export type SiteQuery = Static<typeof siteQuerySchema>
export const siteQueryValidator = getValidator(siteQuerySchema, queryValidator)
