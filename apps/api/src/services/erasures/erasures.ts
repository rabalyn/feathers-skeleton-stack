import { BadRequest, Conflict } from '@feathersjs/errors'
import type { Params } from '@feathersjs/feathers'
import { hooks as schemaHooks } from '@feathersjs/schema'
import { Type, getValidator, type Static } from '@feathersjs/typebox'
import type { Application } from '../../app.js'
import { recordAudit } from '../../audit.js'
import { endUserConnections } from '../../channels.js'
import { dataValidator } from '../../validators.js'
import { USERS_PATH } from '../users/users.js'

// GDPR erasure (ADR 0013), an administrative action only (ADR 0011). The
// erasure itself is erase_user(), the database function a restore replays
// (ADR 0017); around it, this service refuses what must not be erased,
// audits, removes the person's export objects and logs them out everywhere.

export const ERASURES_PATH = 'erasures'
export const ERASURE_EXTERNAL_METHODS = ['create'] as const

export const erasureDataSchema = Type.Object(
  { userId: Type.String({ format: 'uuid' }) },
  { $id: 'ErasureData', additionalProperties: false }
)
export type ErasureData = Static<typeof erasureDataSchema>
export const erasureDataValidator = getValidator(erasureDataSchema, dataValidator)

export interface Erasure {
  userId: string
  erasedAt: string
}

export class ErasureService {
  constructor(private readonly app: Application) {}

  async create(data: ErasureData, params?: Params): Promise<Erasure> {
    const knex = this.app.get('knex')
    const actorId = (params?.user as { id: string } | undefined)?.id ?? null
    if (actorId === data.userId) throw new BadRequest('You cannot erase your own account')

    const { exportIds, erasedAt } = await knex.transaction(async (trx) => {
      const target = await trx('users')
        .where({ id: data.userId })
        .forUpdate()
        .first<{ authSource: string; erasedAt: Date | null } | undefined>('authSource', 'erasedAt')
      if (!target) throw new BadRequest('No such user to erase', { userId: data.userId })
      if (target.authSource === 'local') throw new BadRequest('The break-glass account holds no personal data and cannot be erased')
      if (target.erasedAt) throw new Conflict('This account is already erased')

      // Their objects outlive the rows erase_user() deletes; removed below.
      const exportIds = await trx('dataExports')
        .where({ subjectId: data.userId })
        .orWhere({ requestedBy: data.userId })
        .pluck<string[]>('id')
      await trx.raw('SELECT erase_user(?)', [data.userId])
      await recordAudit(trx, { actorId, action: 'users.erase', resourceType: USERS_PATH, resourceId: data.userId })
      const { erasedAt } = await trx('erasures').where({ userId: data.userId }).first<{ erasedAt: Date }>('erasedAt')
      return { exportIds, erasedAt }
    })

    // Best effort: the export expiry job removes whatever is left behind.
    await this.app
      .get('exports')
      .deleteMany(exportIds)
      .catch((error: Error) =>
        this.app.get('logger').warn({ user_ref: data.userId, err: { message: error.message } }, 'export objects of an erased user not removed')
      )
    endUserConnections(this.app, data.userId)
    // The users service publishes the erased record to everyone who may
    // read it (ADR 0012). Writing the state erase_user() already set is what
    // makes it do so.
    await this.app.service(USERS_PATH).patch(data.userId, { enabled: false })

    return { userId: data.userId, erasedAt: erasedAt.toISOString() }
  }
}

export const erasures = (app: Application) => {
  app.use(ERASURES_PATH, new ErasureService(app), { methods: [...ERASURE_EXTERNAL_METHODS] })
  app.service(ERASURES_PATH).hooks({
    before: { create: [schemaHooks.validateData(erasureDataValidator)] }
  })
}

declare module '../../app.js' {
  interface ServiceTypes {
    [ERASURES_PATH]: ErasureService
  }
}
