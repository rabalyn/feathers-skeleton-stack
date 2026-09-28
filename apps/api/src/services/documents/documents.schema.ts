import { resolve, virtual } from '@feathersjs/schema'
import { Type, getValidator, querySyntax, type Static } from '@feathersjs/typebox'
import type { HookContext } from '../../declarations.js'
import { dataValidator, queryValidator } from '../../validators.js'
import { fileSchema } from '../files/files.schema.js'

// ADR 0009, 0020: a document is an owner, a title and one uploaded file.

const toIso = (value: unknown) => (value instanceof Date ? value.toISOString() : (value as string))

export const documentFileSchema = Type.Pick(fileSchema, ['filename', 'contentType', 'sizeBytes', 'sha256'])

export const documentSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    ownerId: Type.String({ format: 'uuid' }),
    title: Type.String({ minLength: 1, maxLength: 200 }),
    fileId: Type.String({ format: 'uuid' }),
    // The file's metadata, for lists; the bytes are at file-contents/:fileId.
    file: Type.Optional(documentFileSchema),
    createdAt: Type.String({ format: 'date-time' }),
    updatedAt: Type.String({ format: 'date-time' })
  },
  { $id: 'Document', additionalProperties: false }
)
export type Document = Static<typeof documentSchema>

export const documentResolver = resolve<Document, HookContext>({
  file: virtual(async (document, context) => {
    const file = await context.app
      .get('knex')('files')
      .where({ id: document.fileId })
      .first<Omit<Static<typeof documentFileSchema>, 'sizeBytes'> & { sizeBytes: string } | undefined>(
        'filename',
        'contentType',
        'sizeBytes',
        'sha256'
      )
    return file ? { ...file, sizeBytes: Number(file.sizeBytes) } : undefined
  }),
  createdAt: virtual(async (document) => toIso(document.createdAt)),
  updatedAt: virtual(async (document) => toIso(document.updatedAt))
})

export const documentExternalResolver = resolve<Document, HookContext>({})

// The owner is always the caller; a file is attached by its id, after it
// was uploaded to `files`.
export const documentDataSchema = Type.Pick(documentSchema, ['title', 'fileId'], {
  $id: 'DocumentData',
  additionalProperties: false
})
export type DocumentData = Static<typeof documentDataSchema>
export const documentDataValidator = getValidator(documentDataSchema, dataValidator)
export const documentDataResolver = resolve<Document, HookContext>({
  ownerId: async (_value, _document, context) => (context.params.user as { id: string }).id
})

// A new title, or a new file: files are immutable, so replacing one means
// attaching another (ADR 0020).
export const documentPatchSchema = Type.Partial(Type.Pick(documentSchema, ['title', 'fileId']), {
  $id: 'DocumentPatch',
  additionalProperties: false,
  minProperties: 1
})
export type DocumentPatch = Static<typeof documentPatchSchema>
export const documentPatchValidator = getValidator(documentPatchSchema, dataValidator)
export const documentPatchResolver = resolve<Document, HookContext>({
  updatedAt: async () => new Date().toISOString()
})

export const documentQueryProperties = Type.Pick(documentSchema, ['id', 'ownerId', 'title', 'createdAt', 'updatedAt'])
export const documentQuerySchema = Type.Intersect(
  [querySyntax(documentQueryProperties), Type.Object({}, { additionalProperties: false })],
  { additionalProperties: false }
)
export type DocumentQuery = Static<typeof documentQuerySchema>
export const documentQueryValidator = getValidator(documentQuerySchema, queryValidator)
export const documentQueryResolver = resolve<DocumentQuery, HookContext>({})
