import { BadRequest, Conflict, NotFound, Unavailable } from '@feathersjs/errors'
import type { Params } from '@feathersjs/feathers'
import { hooks as schemaHooks } from '@feathersjs/schema'
import { Type, type Static } from '@feathersjs/typebox'
import type { Knex } from 'knex'
import type { Application } from '../../app.js'
import { publishNothing } from '../../channels.js'
import { DirectoryUnavailable, type Directory } from '../../directory.js'
import { limitPerUser } from '../../rate-limit.js'
import { dataValidator, lazyValidator } from '../../validators.js'
import type { DirectoryEntry } from './directory.schema.js'

// One person by the exact value of an attribute the product names as a
// lookup (ADR 0008), such as the number of the card a reader at the counter
// types: `create({ by: 'cardNumber', value })`. A create, so the value
// travels in the body and never in a URL that a proxy logs. Like a search,
// it needs `directory.read`, creates nothing and is no audit event; the
// value is never logged and never returned.

export const DIRECTORY_LOOKUPS_PATH = 'directory-lookups'
export const DIRECTORY_LOOKUP_EXTERNAL_METHODS = ['create'] as const

export const directoryLookupDataSchema = Type.Object(
  {
    // The product's name of the lookup (product/directory.ts).
    by: Type.String({ pattern: '^[a-z][a-zA-Z0-9]{0,63}$' }),
    // Without control characters: a reader's closing newline is the
    // client's to strip.
    value: Type.String({ minLength: 1, maxLength: 128, pattern: '^[^\\x00-\\x1f\\x7f]+$' })
  },
  { $id: 'DirectoryLookupData', additionalProperties: false }
)
export type DirectoryLookupData = Static<typeof directoryLookupDataSchema>
const directoryLookupDataValidator = lazyValidator(directoryLookupDataSchema, dataValidator)

export class DirectoryLookupService {
  constructor(
    private readonly directory: Directory,
    private readonly knex: Knex,
    private readonly lookups: Readonly<Record<string, string>>
  ) {}

  async create(data: DirectoryLookupData, _params?: Params): Promise<DirectoryEntry> {
    const attribute = Object.hasOwn(this.lookups, data.by) ? this.lookups[data.by] : undefined
    if (!attribute) throw new BadRequest(`No directory lookup "${data.by}"`)
    let entries
    try {
      entries = await this.directory.findBy(attribute, data.value)
    } catch (error) {
      if (error instanceof DirectoryUnavailable) throw new Unavailable('Directory unavailable')
      throw error
    }
    if (entries.length === 0) throw new NotFound('Nobody in the directory', { reason: 'not-found' })
    if (entries.length > 1) throw new Conflict('Several people in the directory', { reason: 'ambiguous' })
    const [entry] = entries as [DirectoryEntry]
    const account: { id: string } | undefined = await this.knex('users').where({ tuId: entry.tuId }).first('id')
    return { ...entry, userId: account?.id ?? null }
  }
}

export const directoryLookups = (app: Application) => {
  app.use(
    DIRECTORY_LOOKUPS_PATH,
    new DirectoryLookupService(app.get('directory'), app.get('knex'), app.get('productDirectory').lookups ?? {}),
    { methods: [...DIRECTORY_LOOKUP_EXTERNAL_METHODS] }
  )
  app.service(DIRECTORY_LOOKUPS_PATH).hooks({
    // Each lookup is an LDAP query, counted with the searches (ADR 0010).
    around: { create: [limitPerUser('directorySearch')] },
    before: { create: [schemaHooks.validateData(directoryLookupDataValidator)] }
  })
  // The result goes to the caller only.
  app.service(DIRECTORY_LOOKUPS_PATH).publish(publishNothing)
}

declare module '../../app.js' {
  interface ServiceTypes {
    [DIRECTORY_LOOKUPS_PATH]: DirectoryLookupService
  }
}
