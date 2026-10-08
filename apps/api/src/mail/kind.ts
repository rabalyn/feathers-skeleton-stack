import { Type, type Static, type TObject, type TSchema } from '@feathersjs/typebox'
import type { Knex } from 'knex'
import type { Locale } from '../locales.js'

// Mail kinds (ADR 0027): code declares what a mail can say and to whom;
// admins write the wording. A kind is declared with defineMailKind() and
// registered in mail/registry.ts; admins cannot create kinds.

export const MAIL_KIND_TYPES = ['notification', 'campaign'] as const
export type MailKindType = (typeof MAIL_KIND_TYPES)[number]

// Namespaced by the product (or the skeleton's area): `lending.key-expiry-reminder`.
export const MAIL_KIND_KEY_PATTERN = '^[a-z][a-z0-9-]*\\.[a-z][a-z0-9-]*$'

// What the skeleton adds to every kind's variables: the recipient's names
// and the application's name and public origin (`app.url`), which every
// link in a mail starts with.
export const recipientVariables = Type.Object(
  { givenName: Type.String(), surname: Type.String() },
  { additionalProperties: false }
)
export const appVariables = Type.Object({ name: Type.String(), url: Type.String() }, { additionalProperties: false })
export type RecipientVariables = Static<typeof recipientVariables>
export type AppVariables = Static<typeof appVariables>

export const RESERVED_VARIABLES = ['recipient', 'app'] as const

export interface MailTemplateText {
  subject: string
  // Markdown with Liquid.
  body: string
}

interface MailKindBase<P extends TObject, V extends TObject> {
  key: string
  // Input: surrogate ids for a notification, the admin's choices for a
  // campaign. Never direct identifiers or rendered text (ADR 0024).
  params: P
  // Everything a template may use, besides `recipient` and `app`.
  variables: V
  // The variables for one recipient, computed at send time, so the mail
  // reflects the data when it leaves. `null` skips the recipient. `db` is
  // the camelCase Knex; each call should be one indexed query or close to it.
  build: (db: Knex, userId: string, params: Static<P>) => Promise<Static<V> | null>
  // Example variables, for the editor's preview and the check on save.
  sample: Static<V>
  // The wording a fresh stack sends before anyone edits a template.
  defaults: Record<Locale, MailTemplateText>
  // Optional: what the product records once the relay accepted the mail,
  // such as an entry in its own history. Runs in the transaction that marks
  // the delivery sent, with the variables the mail was rendered from; a
  // failure is logged and does not send the mail again.
  sent?: (trx: Knex.Transaction, mail: SentMail<Static<P>, Static<V>>) => Promise<void>
}

export interface SentMail<P, V> {
  deliveryId: string
  userId: string
  // The campaign the delivery belongs to; null for a notification.
  campaignId: string | null
  params: P
  variables: V
}

export interface NotificationKind<P extends TObject = TObject, V extends TObject = TObject> extends MailKindBase<P, V> {
  type: 'notification'
}

export interface CampaignKind<P extends TObject = TObject, V extends TObject = TObject> extends MailKindBase<P, V> {
  type: 'campaign'
  // A query whose rows have an `id` column: the user ids to mail. The
  // worker runs it when the campaign is sent.
  recipients: (db: Knex, params: Static<P>) => Knex.QueryBuilder
}

export type MailKind<P extends TObject = TObject, V extends TObject = TObject> = NotificationKind<P, V> | CampaignKind<P, V>

export class MailKindError extends Error {}

// A campaign's parameters are filled in a form generated from the schema
// (ADR 0027), which supports strings, numbers, dates, booleans and enums of
// string literals, nothing else.
const isFormField = (schema: TSchema): boolean => {
  const s = schema as { type?: string; anyOf?: { const?: unknown; type?: string }[] }
  if (s.type === 'string' || s.type === 'number' || s.type === 'integer' || s.type === 'boolean') return true
  return Array.isArray(s.anyOf) && s.anyOf.length > 0 && s.anyOf.every((each) => typeof each.const === 'string')
}

const check = (kind: MailKind<TObject, TObject>) => {
  if (!new RegExp(MAIL_KIND_KEY_PATTERN).test(kind.key)) {
    throw new MailKindError(`mail kind ${kind.key}: the key must look like area.name`)
  }
  for (const reserved of RESERVED_VARIABLES) {
    if (reserved in kind.variables.properties) {
      throw new MailKindError(`mail kind ${kind.key}: \`${reserved}\` is added by the skeleton and cannot be declared`)
    }
  }
  if (kind.type === 'campaign') {
    for (const [name, schema] of Object.entries(kind.params.properties)) {
      if (!isFormField(schema)) {
        throw new MailKindError(`mail kind ${kind.key}: campaign parameter ${name} is not a string, number, date, boolean or enum`)
      }
    }
  }
}

export function defineMailKind<P extends TObject, V extends TObject>(kind: NotificationKind<P, V>): NotificationKind<P, V>
export function defineMailKind<P extends TObject, V extends TObject>(kind: CampaignKind<P, V>): CampaignKind<P, V>
export function defineMailKind<P extends TObject, V extends TObject>(kind: MailKind<P, V>): MailKind<P, V> {
  check(kind)
  return kind
}

// Everything a template of this kind may use: the kind's variables plus the
// skeleton's `recipient` and `app`.
export const templateVariables = (kind: MailKind) =>
  Type.Object(
    { ...kind.variables.properties, recipient: recipientVariables, app: appVariables },
    { additionalProperties: false }
  )
