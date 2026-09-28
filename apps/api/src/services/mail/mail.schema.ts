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

// A campaign as sent (ADR 0027): the admin's choices, the revisions it
// pinned per locale, and how far its deliveries have got.
export const mailCampaignSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    kind: kindKey,
    params: Type.Record(Type.String(), Type.Unknown()),
    sentBy: Type.String({ format: 'uuid' }),
    // `pending` until the worker has resolved its recipients.
    status: Type.Union([Type.Literal('pending'), Type.Literal('queued')]),
    recipientCount: Type.Union([Type.Integer(), Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
    queuedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    revisions: Type.Record(Type.String(), Type.String({ format: 'uuid' })),
    progress: Type.Object({ pending: Type.Integer(), sent: Type.Integer(), failed: Type.Integer(), skipped: Type.Integer() })
  },
  { $id: 'MailCampaign', additionalProperties: false }
)
export type MailCampaign = Static<typeof mailCampaignSchema>

export const mailCampaignResolver = resolve<MailCampaign, HookContext>({
  createdAt: virtual(async (campaign) => toIso(campaign.createdAt)),
  queuedAt: virtual(async (campaign) => (campaign.queuedAt ? toIso(campaign.queuedAt) : null)),
  revisions: virtual(async (campaign, context) => {
    const rows = await context.app
      .get('knex')('mailCampaignRevisions')
      .where({ campaignId: campaign.id })
      .select<{ locale: string; revisionId: string }[]>('locale', 'revisionId')
    return Object.fromEntries(rows.map((row) => [row.locale, row.revisionId]))
  }),
  progress: virtual(async (campaign, context) => {
    const rows = await context.app
      .get('knex')('mailDeliveries')
      .where({ campaignId: campaign.id })
      .groupBy('status')
      .select<{ status: string; count: string }[]>('status', context.app.get('knex').raw('count(*) AS count'))
    const counts = Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]))
    return { pending: counts.pending ?? 0, sent: counts.sent ?? 0, failed: counts.failed ?? 0, skipped: counts.skipped ?? 0 }
  })
})
export const mailCampaignExternalResolver = resolve<MailCampaign, HookContext>({})

export const mailCampaignDataSchema = Type.Object(
  { kind: kindKey, params: Type.Record(Type.String(), Type.Unknown()) },
  { $id: 'MailCampaignData', additionalProperties: false }
)
export type MailCampaignData = Static<typeof mailCampaignDataSchema>
export const mailCampaignDataValidator = getValidator(mailCampaignDataSchema, dataValidator)

export const mailCampaignQueryProperties = Type.Pick(mailCampaignSchema, ['id', 'kind', 'sentBy', 'status', 'createdAt'])
export const mailCampaignQuerySchema = Type.Intersect(
  [querySyntax(mailCampaignQueryProperties), Type.Object({}, { additionalProperties: false })],
  { additionalProperties: false }
)
export type MailCampaignQuery = Static<typeof mailCampaignQuerySchema>
export const mailCampaignQueryValidator = getValidator(mailCampaignQuerySchema, queryValidator)

// What sending would do: whom it reaches, how long it takes at the sending
// limit, and how it reads for one of them in each locale.
export const mailCampaignPreviewDataSchema = Type.Object(
  { kind: kindKey, params: Type.Record(Type.String(), Type.Unknown()) },
  { $id: 'MailCampaignPreviewData', additionalProperties: false }
)
export type MailCampaignPreviewData = Static<typeof mailCampaignPreviewDataSchema>
export const mailCampaignPreviewDataValidator = getValidator(mailCampaignPreviewDataSchema, dataValidator)

export interface MailCampaignPreview {
  kind: string
  recipientCount: number
  estimatedSeconds: number
  recipient: { id: string; givenName: string; surname: string } | null
  previews: Record<string, MailPreview> | null
}

// The delivery log (ADR 0027): per mail, to whom (by surrogate id), which
// kind and campaign, the wording's revision and the outcome; never the
// address or the text.
export const mailDeliverySchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    userId: Type.String({ format: 'uuid' }),
    kind: Type.String(),
    campaignId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
    params: Type.Record(Type.String(), Type.Unknown()),
    status: Type.Union([Type.Literal('pending'), Type.Literal('sent'), Type.Literal('failed'), Type.Literal('skipped')]),
    skipReason: Type.Union([Type.String(), Type.Null()]),
    revisionId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
    attempts: Type.Integer(),
    error: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
    completedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()])
  },
  { $id: 'MailDelivery', additionalProperties: false }
)
export type MailDelivery = Static<typeof mailDeliverySchema>

export const mailDeliveryResolver = resolve<MailDelivery, HookContext>({
  createdAt: virtual(async (delivery) => toIso(delivery.createdAt)),
  completedAt: virtual(async (delivery) => (delivery.completedAt ? toIso(delivery.completedAt) : null))
})
export const mailDeliveryExternalResolver = resolve<MailDelivery, HookContext>({})

export const mailDeliveryQueryProperties = Type.Pick(mailDeliverySchema, ['id', 'userId', 'kind', 'campaignId', 'status', 'createdAt'])
export const mailDeliveryQuerySchema = Type.Intersect(
  [querySyntax(mailDeliveryQueryProperties), Type.Object({}, { additionalProperties: false })],
  { additionalProperties: false }
)
export type MailDeliveryQuery = Static<typeof mailDeliveryQuerySchema>
export const mailDeliveryQueryValidator = getValidator(mailDeliveryQuerySchema, queryValidator)
