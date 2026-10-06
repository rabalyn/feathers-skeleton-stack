import type { TSchema } from '@feathersjs/typebox'
import type { Knex } from 'knex'
import { LOCALES, type Locale } from '../locales.js'
import type { Config } from '../config.js'
import { templateVariables, type AppVariables, type MailKind, type MailTemplateText } from './kind.js'
import { MAIL_KINDS } from './registry.js'
import { TemplateError, renderMail, templateVariablePaths, type RenderedMail } from './render.js'

// Template revisions (ADR 0027): the code defaults seeded by migrate, and
// the check every save must pass.

// Stands in for `recipient` wherever no actual recipient is at hand.
export const SAMPLE_RECIPIENT = { givenName: 'Erika', surname: 'Mustermann' }

// `app` in every mail: the product's name and its public origin.
export const appVariables = (config: Pick<Config, 'appName' | 'publicOrigin'>): AppVariables => ({
  name: config.appName,
  url: config.publicOrigin
})

// Inserts each kind's code defaults as revisions by the system, and makes
// them active, for every kind and locale that has no template; never touches
// one that has. Run by the migrate job after the settings. Takes a Knex in
// database names.
export const seedMailTemplates = async (knex: Knex, kinds: readonly MailKind[] = MAIL_KINDS): Promise<string[]> => {
  const seeded: string[] = []
  for (const kind of kinds) {
    for (const locale of LOCALES) {
      await knex.transaction(async (trx) => {
        // Serialises two migrate runs on the same kind.
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`mail_templates:${kind.key}:${locale}`])
        const existing: { kind: string } | undefined = await trx('mail_templates').where({ kind: kind.key, locale }).first('kind')
        if (existing) return
        const [revision]: { id: string }[] = await trx('mail_template_revisions')
          .insert({ kind: kind.key, locale, ...kind.defaults[locale], author_id: null })
          .returning('id')
        await trx('mail_templates').insert({ kind: kind.key, locale, revision_id: revision!.id })
        seeded.push(`${kind.key}:${locale}`)
      })
    }
  }
  return seeded
}

type SchemaNode = TSchema & {
  type?: string
  properties?: Record<string, SchemaNode>
  items?: SchemaNode
  anyOf?: SchemaNode[]
}

// Whether a path a template reads exists in the variables schema. Lists
// and text also have LiquidJS's `size`, lists `first` and `last`; an index
// (literal or computed) reads an item.
const pathExists = (schema: SchemaNode, segments: unknown[]): boolean => {
  if (segments.length === 0) return true
  const [head, ...rest] = segments
  if (schema.anyOf) return schema.anyOf.some((each) => pathExists(each, segments))
  if (schema.type === 'object' && typeof head === 'string') {
    const next = schema.properties?.[head]
    return next !== undefined && pathExists(next, rest)
  }
  if (schema.type === 'array' && schema.items) {
    if (head === 'size') return rest.length === 0
    if (head === 'first' || head === 'last' || typeof head === 'number' || Array.isArray(head)) {
      return pathExists(schema.items, rest)
    }
    return false
  }
  if (schema.type === 'string') return head === 'size' && rest.length === 0
  return false
}

const describePath = (segments: unknown[]) =>
  segments.map((segment, index) => (Array.isArray(segment) ? '[…]' : index === 0 ? String(segment) : `.${String(segment)}`)).join('')

// The check on save (ADR 0027): every variable path the subject and body use
// exists in the kind's variables, and both render against the kind's sample.
// Throws a TemplateError naming the part and line; returns the rendering,
// which the editor shows as the preview.
export const checkTemplate = async (
  kind: MailKind,
  locale: Locale,
  text: MailTemplateText,
  app: AppVariables
): Promise<RenderedMail> => {
  const schema = templateVariables(kind) as SchemaNode
  for (const part of ['subject', 'body'] as const) {
    for (const { segments, line } of templateVariablePaths(locale, part, text[part])) {
      if (!pathExists(schema, segments)) {
        throw new TemplateError(`${part}: ${describePath(segments)} is not a variable of ${kind.key}`, line)
      }
    }
  }
  return renderMail({
    locale,
    ...text,
    variables: { ...kind.sample, recipient: SAMPLE_RECIPIENT, app }
  })
}
