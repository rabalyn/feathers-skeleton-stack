import { resolve, virtual } from '@feathersjs/schema'
import { Type, getValidator, querySyntax, type Static } from '@feathersjs/typebox'
import type { HookContext } from '../../declarations.js'
import { LOCALES } from '../../locales.js'
import { MAIL_KIND_KEY_PATTERN } from '../../mail/kind.js'
import { dataValidator, queryValidator } from '../../validators.js'

// ADR 0027: kinds, templates and their revisions, as admins see them.
// Schemas and types may be imported by the client entry point as types only.

const toIso = (value: unknown) => (value instanceof Date ? value.toISOString() : (value as string))

const kindKey = Type.String({ pattern: MAIL_KIND_KEY_PATTERN, maxLength: 100 })
const locale = Type.Union(LOCALES.map((each) => Type.Literal(each)))
const subject = Type.String({ minLength: 1, maxLength: 200 })
const body = Type.String({ minLength: 1, maxLength: 20000 })

// A kind as declared in code: what its templates may use and, for a
// campaign, the parameters its form asks for. Schemas are JSON Schema.
export const mailKindSchema = Type.Object(
  {
    key: kindKey,
    type: Type.Union([Type.Literal('notification'), Type.Literal('campaign')]),
    params: Type.Record(Type.String(), Type.Unknown()),
    // The kind's variables with `recipient` and `app`.
    variables: Type.Record(Type.String(), Type.Unknown()),
    sample: Type.Record(Type.String(), Type.Unknown())
  },
  { $id: 'MailKind', additionalProperties: false }
)
export type MailKindInfo = Static<typeof mailKindSchema>

// The active wording of a kind in a locale; `id` is `<kind>:<locale>`.
export const mailTemplateSchema = Type.Object(
  {
    id: Type.String(),
    kind: kindKey,
    locale,
    revisionId: Type.String({ format: 'uuid' }),
    subject,
    body,
    updatedAt: Type.String({ format: 'date-time' }),
    // False for a kind no longer declared in code: kept, never sent.
    declared: Type.Boolean()
  },
  { $id: 'MailTemplate', additionalProperties: false }
)
export type MailTemplate = Static<typeof mailTemplateSchema>

// Activating a revision: saving an older one's wording again is a roll back.
export const mailTemplatePatchSchema = Type.Object(
  { revisionId: Type.String({ format: 'uuid' }) },
  { $id: 'MailTemplatePatch', additionalProperties: false }
)
export type MailTemplatePatch = Static<typeof mailTemplatePatchSchema>
export const mailTemplatePatchValidator = getValidator(mailTemplatePatchSchema, dataValidator)

export const mailTemplateQuerySchema = Type.Object(
  { kind: Type.Optional(kindKey), locale: Type.Optional(locale) },
  { $id: 'MailTemplateQuery', additionalProperties: false }
)
export type MailTemplateQuery = Static<typeof mailTemplateQuerySchema>
export const mailTemplateQueryValidator = getValidator(mailTemplateQuerySchema, queryValidator)

export const mailTemplateRevisionSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    kind: kindKey,
    locale,
    subject,
    body,
    // Null for the code defaults.
    authorId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
    createdAt: Type.String({ format: 'date-time' })
  },
  { $id: 'MailTemplateRevision', additionalProperties: false }
)
export type MailTemplateRevision = Static<typeof mailTemplateRevisionSchema>

export const mailTemplateRevisionResolver = resolve<MailTemplateRevision, HookContext>({
  createdAt: virtual(async (revision) => toIso(revision.createdAt))
})
export const mailTemplateRevisionExternalResolver = resolve<MailTemplateRevision, HookContext>({})

// Saving: a new revision, which becomes the active one.
export const mailTemplateRevisionDataSchema = Type.Pick(mailTemplateRevisionSchema, ['kind', 'locale', 'subject', 'body'], {
  $id: 'MailTemplateRevisionData',
  additionalProperties: false
})
export type MailTemplateRevisionData = Static<typeof mailTemplateRevisionDataSchema>
export const mailTemplateRevisionDataValidator = getValidator(mailTemplateRevisionDataSchema, dataValidator)
export const mailTemplateRevisionDataResolver = resolve<MailTemplateRevision, HookContext>({
  authorId: async (_value, _revision, context) => context.params.user?.id ?? null
})

export const mailTemplateRevisionQueryProperties = Type.Pick(mailTemplateRevisionSchema, ['id', 'kind', 'locale', 'authorId', 'createdAt'])
export const mailTemplateRevisionQuerySchema = Type.Intersect(
  [querySyntax(mailTemplateRevisionQueryProperties), Type.Object({}, { additionalProperties: false })],
  { additionalProperties: false }
)
export type MailTemplateRevisionQuery = Static<typeof mailTemplateRevisionQuerySchema>
export const mailTemplateRevisionQueryValidator = getValidator(mailTemplateRevisionQuerySchema, queryValidator)

// Rendering unsaved wording against the kind's sample, for the editor.
export const mailPreviewDataSchema = Type.Pick(mailTemplateRevisionSchema, ['kind', 'locale', 'subject', 'body'], {
  $id: 'MailPreviewData',
  additionalProperties: false
})
export type MailPreviewData = Static<typeof mailPreviewDataSchema>
export const mailPreviewDataValidator = getValidator(mailPreviewDataSchema, dataValidator)

export interface MailPreview {
  subject: string
  html: string
  text: string
}
