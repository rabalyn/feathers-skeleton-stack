import { resolve, virtual } from '@feathersjs/schema'
import { Type, querySyntax, type Static } from '@feathersjs/typebox'
import type { HookContext } from '../../declarations.js'
import { dataValidator, queryValidator, lazyValidator } from '../../validators.js'

// ADR 0013: a GDPR export of one person, built by the worker. Only the
// account that asked for it sees it; its bytes are at
// data-export-contents/:id once it is ready.

const toIso = (value: unknown) => (value instanceof Date ? value.toISOString() : (value as string))
const nullableIso = Type.Union([Type.String({ format: 'date-time' }), Type.Null()])

export const dataExportSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    // The person the export is about.
    subjectId: Type.String({ format: 'uuid' }),
    requestedBy: Type.String({ format: 'uuid' }),
    state: Type.Union([Type.Literal('pending'), Type.Literal('ready'), Type.Literal('failed')]),
    sizeBytes: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    sha256: Type.Union([Type.String({ pattern: '^[0-9a-f]{64}$' }), Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
    completedAt: nullableIso,
    // When the export retention removes it (ADR 0013).
    expiresAt: Type.Optional(Type.String({ format: 'date-time' }))
  },
  { $id: 'DataExport', additionalProperties: false }
)
export type DataExport = Static<typeof dataExportSchema>

export const dataExportResolver = resolve<DataExport, HookContext>({
  sizeBytes: virtual(async (row) => (row.sizeBytes === null ? null : Number(row.sizeBytes))),
  createdAt: virtual(async (row) => toIso(row.createdAt)),
  completedAt: virtual(async (row) => (row.completedAt ? toIso(row.completedAt) : null)),
  expiresAt: virtual(async (row, context) => {
    const days = await context.app.get('settings').get('exportRetentionDays')
    return new Date(new Date(toIso(row.createdAt)).getTime() + days * 86_400_000).toISOString()
  })
})

export const dataExportExternalResolver = resolve<DataExport, HookContext>({})

// Whose export: the caller's own, or, for an admin, anyone's (ADR 0011).
export const dataExportDataSchema = Type.Pick(dataExportSchema, ['subjectId'], {
  $id: 'DataExportData',
  additionalProperties: false
})
export type DataExportData = Static<typeof dataExportDataSchema>
export const dataExportDataValidator = lazyValidator(dataExportDataSchema, dataValidator)
export const dataExportDataResolver = resolve<DataExport, HookContext>({
  requestedBy: async (_value, _row, context) => (context.params.user as { id: string }).id
})

// Internal only: the worker's outcome, written again by the api so that the
// change is published (ADR 0012).
export const dataExportPatchSchema = Type.Partial(Type.Pick(dataExportSchema, ['state', 'sizeBytes', 'sha256', 'completedAt']), {
  $id: 'DataExportPatch',
  additionalProperties: false,
  minProperties: 1
})
export type DataExportPatch = Static<typeof dataExportPatchSchema>
export const dataExportPatchValidator = lazyValidator(dataExportPatchSchema, dataValidator)

export const dataExportQueryProperties = Type.Pick(dataExportSchema, ['id', 'subjectId', 'requestedBy', 'state', 'createdAt'])
export const dataExportQuerySchema = Type.Intersect(
  [querySyntax(dataExportQueryProperties), Type.Object({}, { additionalProperties: false })],
  { additionalProperties: false }
)
export type DataExportQuery = Static<typeof dataExportQuerySchema>
export const dataExportQueryValidator = lazyValidator(dataExportQuerySchema, queryValidator)
export const dataExportQueryResolver = resolve<DataExportQuery, HookContext>({})
