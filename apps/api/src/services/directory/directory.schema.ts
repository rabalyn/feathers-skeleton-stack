import { Type, getValidator, type Static } from '@feathersjs/typebox'
import { MAX_RESULTS, MAX_TERM_LENGTH, MIN_TERM_LENGTH, PAGE_MAX } from '../../directory.js'
import { queryValidator } from '../../validators.js'

// ADR 0008. Directory entries are not records of this application; `userId`
// names the account of a person who has already logged in, if any.

export const directoryEntrySchema = Type.Object(
  {
    tuId: Type.String(),
    givenName: Type.Union([Type.String(), Type.Null()]),
    surname: Type.Union([Type.String(), Type.Null()]),
    email: Type.Union([Type.String(), Type.Null()]),
    userId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()])
  },
  { $id: 'DirectoryEntry', additionalProperties: false }
)
export type DirectoryEntry = Static<typeof directoryEntrySchema>

// The page shape of every find (ADR 0005), plus whether the search reached
// the directory's size limit, so there may be more matches.
export interface DirectoryPage {
  total: number
  limit: number
  skip: number
  truncated: boolean
  data: DirectoryEntry[]
}

export const directoryQuerySchema = Type.Object(
  {
    q: Type.String({ minLength: MIN_TERM_LENGTH, maxLength: MAX_TERM_LENGTH, pattern: '\\S' }),
    $limit: Type.Optional(Type.Integer({ minimum: 0, maximum: PAGE_MAX })),
    $skip: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_RESULTS }))
  },
  { $id: 'DirectoryQuery', additionalProperties: false }
)
export type DirectoryQuery = Static<typeof directoryQuerySchema>
export const directoryQueryValidator = getValidator(directoryQuerySchema, queryValidator)
