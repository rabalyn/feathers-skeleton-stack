import { Type, type Static } from '@feathersjs/typebox'
import { LOCATION_NAME_MAX_LENGTH, SITE_PAGE_MAX, SITE_SEARCH_MAX_LENGTH } from '../../limits.js'
import { dataValidator, lazyValidator, queryValidator } from '../../validators.js'

// Locations inside a site (ADR 0031): rooms, floors, whatever people or
// products add in NetBox. `id` is NetBox's, which application records store
// to reference a room. Adding one is the only write; NetBox is the record.

export const locationSchema = Type.Object(
  {
    id: Type.Integer(),
    siteId: Type.Integer(),
    name: Type.String(),
    status: Type.String(),
    // The location it is nested in, if any (a floor, for example).
    parent: Type.Union([Type.Object({ id: Type.Integer(), name: Type.String() }, { additionalProperties: false }), Type.Null()]),
    // The location in NetBox's web UI, for people with access there.
    netboxUrl: Type.String()
  },
  { $id: 'Location', additionalProperties: false }
)
export type Location = Static<typeof locationSchema>

export interface LocationPage {
  total: number
  limit: number
  skip: number
  data: Location[]
}

export const locationQuerySchema = Type.Object(
  {
    // One site's locations.
    siteId: Type.Optional(Type.Integer({ minimum: 1 })),
    // Words matched against name and description by NetBox.
    q: Type.Optional(Type.String({ maxLength: SITE_SEARCH_MAX_LENGTH })),
    // The locations of the ids records store, retired ones included.
    id: Type.Optional(
      Type.Object(
        { $in: Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1, maxItems: SITE_PAGE_MAX }) },
        { additionalProperties: false }
      )
    ),
    $limit: Type.Optional(Type.Integer({ minimum: 0, maximum: SITE_PAGE_MAX })),
    $skip: Type.Optional(Type.Integer({ minimum: 0 }))
  },
  { $id: 'LocationQuery', additionalProperties: false }
)
export type LocationQuery = Static<typeof locationQuerySchema>
export const locationQueryValidator = lazyValidator(locationQuerySchema, queryValidator)

// A location by its name in a site: the existing one of that name, regardless
// of case, or a new one at the site's top level.
export const locationDataSchema = Type.Object(
  {
    siteId: Type.Integer({ minimum: 1 }),
    name: Type.String({ minLength: 1, maxLength: LOCATION_NAME_MAX_LENGTH, pattern: '\\S' })
  },
  { $id: 'LocationData', additionalProperties: false }
)
export type LocationData = Static<typeof locationDataSchema>
export const locationDataValidator = lazyValidator(locationDataSchema, dataValidator)
