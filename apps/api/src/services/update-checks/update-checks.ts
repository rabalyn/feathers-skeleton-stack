import type { Params } from '@feathersjs/feathers'
import { hooks as schemaHooks } from '@feathersjs/schema'
import { Type, getValidator, type Static } from '@feathersjs/typebox'
import type { Application } from '../../app.js'
import { publishNothing } from '../../channels.js'
import { limitPerUser } from '../../rate-limit.js'
import { dataValidator } from '../../validators.js'
import { SYSTEM_INFO_PATH } from '../system-info/system-info.js'

// Asking for the update check now (ADR 0032), instead of waiting for the
// night: an action, asked for with `create`, under `system-info.check`
// (ADR 0011). It queues the check on the worker's maintenance queue and
// returns; the system-info page learns of the end from its `check` event.
// Refused while a check runs or waits to, and when the check is off.

export const UPDATE_CHECKS_PATH = 'update-checks'
export const UPDATE_CHECK_EXTERNAL_METHODS = ['create'] as const

export const updateCheckDataSchema = Type.Object({}, { $id: 'UpdateCheckData', additionalProperties: false })
export type UpdateCheckData = Static<typeof updateCheckDataSchema>
export const updateCheckDataValidator = getValidator(updateCheckDataSchema, dataValidator)

export interface UpdateCheck {
  queuedAt: string
}

export class UpdateCheckService {
  constructor(private readonly app: Application) {}

  async create(_data: UpdateCheckData, _params?: Params): Promise<UpdateCheck> {
    await this.app.service(SYSTEM_INFO_PATH).askForCheck()
    this.app.get('logger').info({ path: UPDATE_CHECKS_PATH }, 'update check asked for')
    return { queuedAt: new Date().toISOString() }
  }
}

export const updateChecks = (app: Application) => {
  app.use(UPDATE_CHECKS_PATH, new UpdateCheckService(app), { methods: [...UPDATE_CHECK_EXTERNAL_METHODS] })
  app.service(UPDATE_CHECKS_PATH).hooks({
    // The check calls out to the update sources (ADR 0010).
    around: { create: [limitPerUser('updateChecks')] },
    before: { create: [schemaHooks.validateData(updateCheckDataValidator)] }
  })
  // The result goes to the caller only (ADR 0012).
  app.service(UPDATE_CHECKS_PATH).publish(publishNothing)
}

declare module '../../app.js' {
  interface ServiceTypes {
    [UPDATE_CHECKS_PATH]: UpdateCheckService
  }
}
