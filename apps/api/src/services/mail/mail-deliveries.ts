import type { Params } from '@feathersjs/feathers'
import { KnexService } from '@feathersjs/knex'
import { hooks as schemaHooks } from '@feathersjs/schema'
import type { Application } from '../../app.js'
import type { HookContext } from '../../declarations.js'
import { PAGINATE } from '../../paginate.js'
import {
  mailDeliveryExternalResolver,
  mailDeliveryQueryValidator,
  mailDeliveryResolver,
  type MailDelivery,
  type MailDeliveryQuery
} from './mail.schema.js'

// Reading the delivery log (ADR 0027), the admin's alone (ADR 0011): did
// this person get the reminder, and in which wording. Read-only: rows are
// written by mail.notify(), campaigns and the worker, never through this
// service, which therefore publishes nothing.

export const MAIL_DELIVERIES_PATH = 'mail-deliveries'
export const MAIL_DELIVERY_EXTERNAL_METHODS = ['find', 'get'] as const

export type MailDeliveryParams = Params<MailDeliveryQuery>

export class MailDeliveryService extends KnexService<MailDelivery, never, MailDeliveryParams> {}

const newestFirst = async (context: HookContext<MailDeliveryService>) => {
  const query = context.params.query ?? {}
  if (!query.$sort) context.params.query = { ...query, $sort: { createdAt: -1, id: -1 } }
}

export const mailDeliveries = (app: Application) => {
  app.use(
    MAIL_DELIVERIES_PATH,
    new MailDeliveryService({ Model: app.get('knex'), name: 'mail_deliveries', id: 'id', paginate: PAGINATE }),
    { methods: [...MAIL_DELIVERY_EXTERNAL_METHODS] }
  )
  app.service(MAIL_DELIVERIES_PATH).hooks({
    around: {
      all: [schemaHooks.resolveExternal(mailDeliveryExternalResolver), schemaHooks.resolveResult(mailDeliveryResolver)]
    },
    before: {
      all: [schemaHooks.validateQuery(mailDeliveryQueryValidator)],
      find: [newestFirst]
    }
  })
}

declare module '../../app.js' {
  interface ServiceTypes {
    [MAIL_DELIVERIES_PATH]: MailDeliveryService
  }
}
