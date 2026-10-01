import { Unavailable } from '@feathersjs/errors'
import { hooks as schemaHooks } from '@feathersjs/schema'
import type { Params } from '@feathersjs/feathers'
import type { Knex } from 'knex'
import type { Application } from '../../app.js'
import { publishNothing } from '../../channels.js'
import { DirectoryUnavailable, PAGE_MAX, type Directory } from '../../directory.js'
import { PAGINATE } from '../../paginate.js'
import { directoryQueryValidator, type DirectoryPage, type DirectoryQuery } from './directory.schema.js'

export type DirectoryParams = Params<DirectoryQuery>

export const DIRECTORY_PATH = 'directory'
export const DIRECTORY_EXTERNAL_METHODS = ['find'] as const

// Lookup only (ADR 0008): nothing is created from a result; a person gets an
// account by logging in (ADR 0009). Available to admin and operator (ADR 0011).
export class DirectoryService {
  constructor(
    private readonly directory: Directory,
    private readonly knex: Knex
  ) {}

  async find(params?: DirectoryParams): Promise<DirectoryPage> {
    const query = params?.query as DirectoryQuery
    let result
    try {
      result = await this.directory.search(query.q)
    } catch (error) {
      if (error instanceof DirectoryUnavailable) throw new Unavailable('Directory unavailable')
      throw error
    }
    // LDAP pages hold at most PAGE_MAX entries (ADR 0008).
    const limit = Math.min(query.$limit ?? PAGINATE.default, PAGE_MAX)
    const skip = query.$skip ?? 0
    const page = result.entries.slice(skip, skip + limit)

    const accounts: { id: string; tuId: string }[] = page.length
      ? await this.knex('users').whereIn('tuId', page.map((entry) => entry.tuId)).select('id', 'tuId')
      : []
    const idOf = new Map(accounts.map((account) => [account.tuId, account.id]))

    return {
      total: result.entries.length,
      limit,
      skip,
      truncated: result.truncated,
      data: page.map((entry) => ({ ...entry, userId: idOf.get(entry.tuId) ?? null }))
    }
  }
}

export const directory = (app: Application) => {
  app.use(DIRECTORY_PATH, new DirectoryService(app.get('directory'), app.get('knex')), {
    methods: [...DIRECTORY_EXTERNAL_METHODS]
  })
  app.service(DIRECTORY_PATH).hooks({
    before: { find: [schemaHooks.validateQuery(directoryQueryValidator)] }
  })
  // Read only.
  app.service(DIRECTORY_PATH).publish(publishNothing)
}

declare module '../../app.js' {
  interface ServiceTypes {
    [DIRECTORY_PATH]: DirectoryService
  }
}
