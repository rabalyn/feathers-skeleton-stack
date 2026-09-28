import { resolve, virtual } from '@feathersjs/schema'
import { Type, getValidator, querySyntax, type Static } from '@feathersjs/typebox'
import type { HookContext } from '../../declarations.js'
import { ALLOWED_CONTENT_TYPES } from '../../uploads.js'
import { dataValidator, queryValidator } from '../../validators.js'

// ADR 0005, 0020. One row per object in the uploads bucket. Schemas and
// types may be imported by the client entry point as types only.

export { ALLOWED_CONTENT_TYPES, AVATAR_CONTENT_TYPES, FILENAME_HEADER, type AllowedContentType } from '../../uploads.js'

const nullableDate = Type.Union([Type.String({ format: 'date-time' }), Type.Null()])

export const fileSchema = Type.Object(
  {
    // Also the object's key in the bucket.
    id: Type.String({ format: 'uuid' }),
    ownerId: Type.String({ format: 'uuid' }),
    // Metadata only; never part of a key or a path.
    filename: Type.String({ minLength: 1, maxLength: 255 }),
    contentType: Type.Union(ALLOWED_CONTENT_TYPES.map((type) => Type.Literal(type))),
    sizeBytes: Type.Integer({ minimum: 1 }),
    sha256: Type.Union([Type.String({ pattern: '^[0-9a-f]{64}$' }), Type.Null()]),
    state: Type.Union([Type.Literal('pending'), Type.Literal('stored')]),
    createdAt: Type.String({ format: 'date-time' }),
    attachedAt: nullableDate,
    deletedAt: nullableDate
  },
  { $id: 'File', additionalProperties: false }
)
export type File = Static<typeof fileSchema>

const toIso = (value: unknown) => (value instanceof Date ? value.toISOString() : (value as string | null))

export const fileResolver = resolve<File, HookContext>({
  // PostgreSQL bigint arrives as a string.
  sizeBytes: virtual(async (file) => Number(file.sizeBytes)),
  createdAt: virtual(async (file) => toIso(file.createdAt) as string),
  attachedAt: virtual(async (file) => toIso(file.attachedAt ?? null)),
  deletedAt: virtual(async (file) => toIso(file.deletedAt ?? null))
})

// Soft deletion and the upload's bookkeeping stay internal.
export const fileExternalResolver = resolve<File, HookContext>({
  state: async () => undefined,
  attachedAt: async () => undefined,
  deletedAt: async () => undefined
})

// What the client sends beside the body: the filename, from its header.
// No path separators or control characters, although it is only ever
// metadata.
export const fileDataSchema = Type.Object(
  { filename: Type.String({ minLength: 1, maxLength: 255, pattern: '^[^\\u0000-\\u001f\\u007f/\\\\]+$' }) },
  { $id: 'FileData', additionalProperties: false }
)
export type FileData = Static<typeof fileDataSchema>
export const fileDataValidator = getValidator(fileDataSchema, dataValidator)

export const fileQueryProperties = Type.Pick(fileSchema, ['id', 'ownerId', 'contentType', 'createdAt'])
export const fileQuerySchema = Type.Intersect(
  [querySyntax(fileQueryProperties), Type.Object({}, { additionalProperties: false })],
  { additionalProperties: false }
)
export type FileQuery = Static<typeof fileQuerySchema>
export const fileQueryValidator = getValidator(fileQuerySchema, queryValidator)
