import type { NextFunction, Params } from '@feathersjs/feathers'
import { KnexService } from '@feathersjs/knex'
import { hooks as schemaHooks } from '@feathersjs/schema'
import type { Application } from '../../app.js'
import { publishTo, roleChannel, userChannel } from '../../channels.js'
import type { HookContext } from '../../declarations.js'
import { PAGINATE } from '../../paginate.js'
import { ALLOWED_CONTENT_TYPES } from '../files/files.schema.js'
import { attachFile, releaseFile } from '../files/attachments.js'
import {
  documentDataResolver,
  documentDataValidator,
  documentExternalResolver,
  documentPatchResolver,
  documentPatchValidator,
  documentQueryResolver,
  documentQueryValidator,
  documentResolver,
  type Document,
  type DocumentData,
  type DocumentPatch,
  type DocumentQuery
} from './documents.schema.js'

// Documents (ADR 0009, 0020): the skeleton's example of an owned record with
// a file. Who may do what is in abilities.ts (ADR 0011).

export type DocumentParams = Params<DocumentQuery>

export class DocumentService extends KnexService<Document, DocumentData, DocumentParams, DocumentPatch> {}

export const DOCUMENTS_PATH = 'documents'
export const DOCUMENT_EXTERNAL_METHODS = ['find', 'get', 'create', 'patch', 'remove'] as const

const callerId = (context: HookContext) => (context.params.user as { id: string }).id

// The file named in the data must be one the caller uploaded, stored and not
// yet attached. Attaching and writing the row happen in one transaction, so
// a failed write leaves the file unattached for the purge job.
const withAttachedFile = async (context: HookContext<DocumentService>, next: NextFunction) => {
  const fileId = (context.data as Partial<DocumentData> | undefined)?.fileId
  if (!fileId) {
    await next()
    return
  }
  const before = context.method === 'patch' && context.id !== null && context.id !== undefined ? await context.service._get(context.id) : undefined
  const knex = context.app.get('knex')
  await knex.transaction(async (trx) => {
    await attachFile(trx, fileId, { ownerId: callerId(context), allowedTypes: ALLOWED_CONTENT_TYPES })
    context.params = { ...context.params, transaction: { trx } } as typeof context.params
    await next()
    // The replaced file is released with the change that replaced it.
    if (before && before.fileId !== fileId) await releaseFile(trx, before.fileId)
  })
}

const releaseRemovedFile = async (context: HookContext<DocumentService>) => {
  const removed = context.result as Document | Document[]
  for (const document of Array.isArray(removed) ? removed : [removed]) {
    await releaseFile(context.app.get('knex'), document.fileId)
  }
}

export const documents = (app: Application) => {
  app.use(
    DOCUMENTS_PATH,
    new DocumentService({ Model: app.get('knex'), name: 'documents', id: 'id', paginate: PAGINATE }),
    { methods: [...DOCUMENT_EXTERNAL_METHODS] }
  )

  app.service(DOCUMENTS_PATH).hooks({
    around: {
      all: [schemaHooks.resolveExternal(documentExternalResolver), schemaHooks.resolveResult(documentResolver)],
      // Validated before the file is attached.
      create: [
        schemaHooks.validateData(documentDataValidator),
        schemaHooks.resolveData(documentDataResolver),
        withAttachedFile
      ],
      patch: [
        schemaHooks.validateData(documentPatchValidator),
        schemaHooks.resolveData(documentPatchResolver),
        withAttachedFile
      ]
    },
    before: {
      all: [schemaHooks.validateQuery(documentQueryValidator), schemaHooks.resolveQuery(documentQueryResolver)]
    },
    after: {
      remove: [releaseRemovedFile]
    }
  })

  // A document concerns its owner, and operators and admins, who see all
  // documents (ADR 0011, 0012).
  app.service(DOCUMENTS_PATH).publish(
    publishTo(app, (document) => [userChannel(String(document.ownerId)), roleChannel('admin'), roleChannel('operator')])
  )
}

declare module '../../app.js' {
  interface ServiceTypes {
    [DOCUMENTS_PATH]: DocumentService
  }
}
