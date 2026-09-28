import type { Readable } from 'node:stream'
import { subject } from '@casl/ability'
import { BadRequest, Conflict, MethodNotAllowed, NotFound, Unavailable } from '@feathersjs/errors'
import type { NextFunction, Params } from '@feathersjs/feathers'
import { ERROR, KnexService } from '@feathersjs/knex'
import { hooks as schemaHooks } from '@feathersjs/schema'
import { Queue, QueueEvents } from 'bullmq'
import type { Application } from '../../app.js'
import { recordAudit } from '../../audit.js'
import { publishTo, userChannel } from '../../channels.js'
import type { HookContext } from '../../declarations.js'
import { EXPORT_CONTENT_TYPE } from '../../gdpr/export.js'
import { BUILD_EXPORT, DATA_EXPORTS_QUEUE, EXPORT_JOB_OPTIONS, queueConnection, type ExportJob } from '../../jobs/queues.js'
import { PAGINATE } from '../../paginate.js'
import { currentRequest } from '../../request-context.js'
import { contentDisposition } from '../files/files.js'
import {
  dataExportDataResolver,
  dataExportDataValidator,
  dataExportExternalResolver,
  dataExportPatchValidator,
  dataExportQueryResolver,
  dataExportQueryValidator,
  dataExportResolver,
  type DataExport,
  type DataExportData,
  type DataExportPatch,
  type DataExportQuery
} from './data-exports.schema.js'

// GDPR data export (ADR 0013). Creating one records the request and hands
// it to the worker (ADR 0024); the worker writes the outcome to the row, and
// the api relays it from the queue's events as a `patched` event, so the
// requester's browser learns of it through the channels (ADR 0012). The
// bytes come back through data-export-contents, to the requester only.

export const DATA_EXPORTS_PATH = 'data-exports'
export const DATA_EXPORT_CONTENTS_PATH = 'data-export-contents'
export const DATA_EXPORT_EXTERNAL_METHODS = ['find', 'get', 'create'] as const

export type DataExportParams = Params<DataExportQuery>

// The index allowing one pending export per person. The adapter turns the
// violation into a 400 and keeps PostgreSQL's error under ERROR.
const ONE_PENDING = 'data_exports_one_pending_key'
const isOnePendingViolation = (error: unknown) =>
  (error as { [ERROR]?: { constraint?: string } } | undefined)?.[ERROR]?.constraint === ONE_PENDING ||
  (error as { constraint?: string } | undefined)?.constraint === ONE_PENDING

export class DataExportService extends KnexService<DataExport, DataExportData, DataExportParams, DataExportPatch> {
  private queue?: Queue<ExportJob>
  private queueEvents?: QueueEvents

  async setup(app: Application) {
    const config = app.get('config')
    const connection = queueConnection(config)
    this.queue = new Queue<ExportJob>(DATA_EXPORTS_QUEUE, {
      connection,
      prefix: config.queuePrefix,
      defaultJobOptions: EXPORT_JOB_OPTIONS
    })
    this.queueEvents = new QueueEvents(DATA_EXPORTS_QUEUE, { connection, prefix: config.queuePrefix })
    const relay = ({ jobId }: { jobId: string }) => {
      this.relay(jobId).catch((error: Error) =>
        app.get('logger').warn({ export_id: jobId, err: { message: error.message } }, 'export outcome not relayed')
      )
    }
    this.queueEvents.on('completed', relay)
    this.queueEvents.on('failed', relay)
  }

  async teardown() {
    await Promise.all([this.queueEvents?.close(), this.queue?.close()])
  }

  async enqueue(exportId: string) {
    if (!this.queue) throw new Unavailable('Exports are not available')
    await this.queue.add(BUILD_EXPORT, { exportId, requestId: currentRequest()?.requestId }, { jobId: exportId })
  }

  // The worker wrote the outcome; writing it again through the service
  // publishes it. An event for an export still pending (a retry) or gone
  // (erased) changes nothing.
  async relay(exportId: string) {
    const row = await this._get(exportId).catch(() => undefined)
    if (!row || row.state === 'pending') return
    // Raw row values: bigint as a string, timestamps as dates.
    await this.patch(exportId, {
      state: row.state,
      sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
      sha256: row.sha256,
      completedAt: row.completedAt === null ? null : new Date(row.completedAt).toISOString()
    })
  }
}

// The subject must be a person the system still knows: not erased, not
// missing. Same answer for both, like a missing file (ADR 0011).
const checkSubject = async (context: HookContext<DataExportService>) => {
  const { subjectId } = context.data as DataExportData
  const subjectRow = await context.app
    .get('knex')('users')
    .where({ id: subjectId })
    .whereNull('erasedAt')
    .first<{ id: string } | undefined>('id')
  if (!subjectRow) throw new BadRequest('No such user to export', { subjectId })
}

// The row and its audit event commit together (ADR 0013); the job is
// enqueued once they have. An export that cannot be enqueued is failed at
// once, so it does not block the next request for a day.
const requestExport = async (context: HookContext<DataExportService>, next: NextFunction) => {
  const knex = context.app.get('knex')
  try {
    await knex.transaction(async (trx) => {
      context.params = { ...context.params, transaction: { trx } } as typeof context.params
      await next()
      const created = context.result as DataExport
      await recordAudit(trx, {
        actorId: created.requestedBy,
        action: 'data-exports.create',
        resourceType: DATA_EXPORTS_PATH,
        resourceId: created.id,
        detail: { subjectId: created.subjectId }
      })
    })
  } catch (error) {
    if (isOnePendingViolation(error)) {
      throw new Conflict('An export of this person is already being prepared')
    }
    throw error
  }
  const created = context.result as DataExport
  try {
    await context.service.enqueue(created.id)
  } catch (error) {
    await knex('dataExports').where({ id: created.id, state: 'pending' }).update({ state: 'failed', completedAt: knex.fn.now() })
    context.app.get('logger').error({ export_id: created.id, err: { message: (error as Error).message } }, 'export not enqueued')
    throw new Unavailable('The export could not be started; please try again')
  }
}

export interface DataExportContent {
  dataExport: DataExport
  body: Readable
  length: number
}

// get(id) streams a ready export to the account that asked for it; to
// anyone else it is a 404, like one that does not exist. Every download is
// audited.
export class DataExportContentService {
  constructor(private readonly app: Application) {}

  async get(id: string, params?: Params): Promise<DataExportContent> {
    const service = this.app.service(DATA_EXPORTS_PATH)
    const row = await service._get(id, { query: { state: 'ready' } }).catch(() => undefined)
    const ability = params?.ability as { can(action: string, subject: unknown): boolean } | undefined
    if (!row || (params?.provider && !ability?.can('read', subject(DATA_EXPORTS_PATH, { ...row })))) {
      throw new NotFound(`No record found for id '${id}'`)
    }
    const stored = await this.app.get('exports').get(id)
    if (!stored) {
      this.app.get('logger').error({ export_id: id }, 'object missing for a ready export')
      throw new NotFound(`No record found for id '${id}'`)
    }
    await recordAudit(this.app.get('knex'), {
      actorId: (params?.user as { id: string } | undefined)?.id ?? null,
      action: 'data-exports.download',
      resourceType: DATA_EXPORTS_PATH,
      resourceId: id,
      detail: { subjectId: row.subjectId }
    })
    return { dataExport: await dataExportResolver.resolve(row, { app: this.app } as HookContext), body: stored.body, length: stored.length }
  }
}

const sendExport = async (context: HookContext<DataExportContentService>, next: NextFunction) => {
  if (context.params.provider && context.params.provider !== 'rest') {
    throw new MethodNotAllowed('Exports are downloaded over HTTP only')
  }
  await next()
  const { dataExport, body, length } = context.result as DataExportContent
  context.http = {
    ...context.http,
    headers: {
      'content-type': EXPORT_CONTENT_TYPE,
      'content-length': String(length),
      'content-disposition': contentDisposition('attachment', `data-export-${dataExport.createdAt.slice(0, 10)}.zip`),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, no-store'
    }
  }
  context.result = body as unknown as DataExportContent
}

// External patches do not exist; the internal one is the relay's.
const validateInternalPatch = async (context: HookContext<DataExportService>, next: NextFunction) => {
  if (context.params.provider) throw new MethodNotAllowed()
  await schemaHooks.validateData(dataExportPatchValidator)(context, next)
}

export const dataExports = (app: Application) => {
  app.use(DATA_EXPORTS_PATH, new DataExportService({ Model: app.get('knex'), name: 'data_exports', id: 'id', paginate: PAGINATE }), {
    methods: [...DATA_EXPORT_EXTERNAL_METHODS]
  })
  app.service(DATA_EXPORTS_PATH).hooks({
    around: {
      all: [schemaHooks.resolveExternal(dataExportExternalResolver), schemaHooks.resolveResult(dataExportResolver)],
      create: [
        schemaHooks.validateData(dataExportDataValidator),
        schemaHooks.resolveData(dataExportDataResolver),
        requestExport
      ],
      patch: [validateInternalPatch]
    },
    before: {
      all: [schemaHooks.validateQuery(dataExportQueryValidator), schemaHooks.resolveQuery(dataExportQueryResolver)],
      create: [checkSubject]
    }
  })
  // An export concerns the account that asked for it, only (ADR 0013).
  app.service(DATA_EXPORTS_PATH).publish(publishTo(app, (row) => [userChannel(String(row.requestedBy))]))

  app.use(DATA_EXPORT_CONTENTS_PATH, new DataExportContentService(app), { methods: ['get'] })
  app.service(DATA_EXPORT_CONTENTS_PATH).hooks({ around: { get: [sendExport] } })
}

declare module '../../app.js' {
  interface ServiceTypes {
    [DATA_EXPORTS_PATH]: DataExportService
    [DATA_EXPORT_CONTENTS_PATH]: DataExportContentService
  }
}
