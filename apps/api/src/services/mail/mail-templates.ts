import { BadRequest, NotFound } from '@feathersjs/errors'
import type { NextFunction, Params } from '@feathersjs/feathers'
import { KnexService } from '@feathersjs/knex'
import { hooks as schemaHooks } from '@feathersjs/schema'
import type { Knex } from 'knex'
import type { Application } from '../../app.js'
import { recordAudit } from '../../audit.js'
import { publishTo, subjectChannel } from '../../channels.js'
import type { HookContext } from '../../declarations.js'
import type { Locale } from '../../locales.js'
import { templateVariables } from '../../mail/kind.js'
import { MAIL_KINDS, getMailKind } from '../../mail/registry.js'
import { TemplateError } from '../../mail/render.js'
import { checkTemplate } from '../../mail/templates.js'
import { PAGINATE } from '../../paginate.js'
import {
  mailPreviewDataValidator,
  mailTemplatePatchValidator,
  mailTemplateQueryValidator,
  mailTemplateRevisionDataResolver,
  mailTemplateRevisionDataValidator,
  mailTemplateRevisionExternalResolver,
  mailTemplateRevisionQueryValidator,
  mailTemplateRevisionResolver,
  type MailKindInfo,
  type MailPreview,
  type MailPreviewData,
  type MailTemplate,
  type MailTemplatePatch,
  type MailTemplateQuery,
  type MailTemplateRevision,
  type MailTemplateRevisionData,
  type MailTemplateRevisionQuery
} from './mail.schema.js'

// Mail wording (ADR 0027), the admin's alone (ADR 0011): the kinds code
// declares, the active template per kind and locale, its immutable
// revisions, and previews of unsaved wording. Saving writes a revision and
// makes it active; activating an older one rolls back. Both are audited.

export const MAIL_KINDS_PATH = 'mail-kinds'
export const MAIL_TEMPLATES_PATH = 'mail-templates'
export const MAIL_TEMPLATE_REVISIONS_PATH = 'mail-template-revisions'
export const MAIL_PREVIEWS_PATH = 'mail-previews'
export const MAIL_KIND_EXTERNAL_METHODS = ['find', 'get'] as const
export const MAIL_TEMPLATE_EXTERNAL_METHODS = ['find', 'get', 'patch'] as const
export const MAIL_TEMPLATE_REVISION_EXTERNAL_METHODS = ['find', 'get', 'create'] as const
export const MAIL_PREVIEW_EXTERNAL_METHODS = ['create'] as const

// A template that fails the check, as a 400 naming the part and line.
export const templateRefused = (error: unknown): never => {
  if (!(error instanceof TemplateError)) throw error
  const [part, ...rest] = error.message.split(': ')
  throw new BadRequest('The template does not work', {
    errors: [{ part, line: error.line ?? null, message: rest.join(': ') || error.message }]
  })
}

const kindInfo = (key: string): MailKindInfo => {
  const kind = getMailKind(key)
  if (!kind) throw new NotFound(`No record found for id '${key}'`)
  return {
    key: kind.key,
    type: kind.type,
    params: kind.params,
    variables: templateVariables(kind),
    sample: kind.sample
  }
}

export class MailKindService {
  async find(_params?: Params): Promise<MailKindInfo[]> {
    return MAIL_KINDS.map((kind) => kindInfo(kind.key))
  }

  async get(key: string, _params?: Params): Promise<MailKindInfo> {
    return kindInfo(key)
  }
}

const templateId = (kind: string, locale: string) => `${kind}:${locale}`
const parseTemplateId = (id: string) => {
  const at = id.lastIndexOf(':')
  return { kind: id.slice(0, at), locale: id.slice(at + 1) }
}

interface TemplateRow {
  kind: string
  locale: Locale
  revisionId: string
  subject: string
  body: string
  updatedAt: Date
}

const templateRows = (knex: Knex | Knex.Transaction) =>
  knex('mailTemplates as t')
    .join('mailTemplateRevisions as r', 'r.id', 't.revisionId')
    .select('t.kind', 't.locale', 't.revisionId', 'r.subject', 'r.body', 't.updatedAt')
    .orderBy(['t.kind', 't.locale'])

const toTemplate = (row: TemplateRow): MailTemplate => ({
  id: templateId(row.kind, row.locale),
  kind: row.kind,
  locale: row.locale,
  revisionId: row.revisionId,
  subject: row.subject,
  body: row.body,
  updatedAt: row.updatedAt.toISOString(),
  declared: getMailKind(row.kind) !== undefined
})

export class MailTemplateService {
  constructor(private readonly app: Application) {}

  async find(params?: Params<MailTemplateQuery>): Promise<MailTemplate[]> {
    const query = params?.query ?? {}
    const rows = await templateRows(this.app.get('knex')).where((builder) => {
      if (query.kind) void builder.where('t.kind', query.kind)
      if (query.locale) void builder.where('t.locale', query.locale)
    })
    return (rows as TemplateRow[]).map(toTemplate)
  }

  async get(id: string, params?: Params & { transaction?: { trx: Knex.Transaction } }): Promise<MailTemplate> {
    const { kind, locale } = parseTemplateId(String(id))
    const row: TemplateRow | undefined = await templateRows(params?.transaction?.trx ?? this.app.get('knex'))
      .where({ 't.kind': kind, 't.locale': locale })
      .first<TemplateRow | undefined>()
    if (!row) throw new NotFound(`No record found for id '${id}'`)
    return toTemplate(row)
  }

  // Makes a revision of this kind and locale the active one.
  async patch(id: string, data: MailTemplatePatch, params?: Params): Promise<MailTemplate> {
    const { kind, locale } = parseTemplateId(String(id))
    return this.app.get('knex').transaction(async (trx) => {
      const revision: { id: string } | undefined = await trx('mailTemplateRevisions')
        .where({ id: data.revisionId, kind, locale })
        .first('id')
      if (!revision) throw new BadRequest('No such revision of this template', { revisionId: data.revisionId })
      const updated = await trx('mailTemplates')
        .where({ kind, locale })
        .update({ revisionId: data.revisionId, updatedAt: trx.fn.now() })
      if (updated === 0) throw new NotFound(`No record found for id '${id}'`)
      if (params?.provider) {
        await recordAudit(trx, {
          actorId: params.user?.id ?? null,
          action: 'mail.template.activate',
          resourceType: MAIL_TEMPLATES_PATH,
          resourceId: templateId(kind, locale),
          detail: { revisionId: data.revisionId }
        })
      }
      return this.get(templateId(kind, locale), { transaction: { trx } })
    })
  }
}

export type MailTemplateRevisionParams = Params<MailTemplateRevisionQuery>

export class MailTemplateRevisionService extends KnexService<
  MailTemplateRevision,
  MailTemplateRevisionData,
  MailTemplateRevisionParams
> {}

// Only kinds declared in code can be edited, and only with wording that
// passes the check (ADR 0027).
const checkRevision = async (context: HookContext<MailTemplateRevisionService>) => {
  const data = context.data as MailTemplateRevisionData
  const kind = getMailKind(data.kind)
  if (!kind) throw new BadRequest('No such mail kind', { kind: data.kind })
  await checkTemplate(kind, data.locale, data, context.app.get('config').publicOrigin).catch(templateRefused)
}

// The revision, its activation and the audit event commit together; the
// template's change is published after.
const saveRevision = async (context: HookContext<MailTemplateRevisionService>, next: NextFunction) => {
  await context.app.get('knex').transaction(async (trx) => {
    context.params = { ...context.params, transaction: { trx } } as typeof context.params
    await next()
    const revision = context.result as MailTemplateRevision
    await trx('mailTemplates')
      .insert({ kind: revision.kind, locale: revision.locale, revisionId: revision.id })
      .onConflict(['kind', 'locale'])
      .merge({ revisionId: revision.id, updatedAt: trx.fn.now() })
    await recordAudit(trx, {
      actorId: context.params.user?.id ?? null,
      action: 'mail.template.save',
      resourceType: MAIL_TEMPLATES_PATH,
      resourceId: templateId(revision.kind, revision.locale),
      detail: { revisionId: revision.id }
    })
  })
  const revision = context.result as MailTemplateRevision
  const templates = context.app.service(MAIL_TEMPLATES_PATH)
  templates.emit('patched', await templates.get(templateId(revision.kind, revision.locale)))
}

const newestFirst = async (context: HookContext<MailTemplateRevisionService>) => {
  const query = context.params.query ?? {}
  if (!query.$sort) context.params.query = { ...query, $sort: { createdAt: -1, id: -1 } }
}

export class MailPreviewService {
  constructor(private readonly app: Application) {}

  async create(data: MailPreviewData, _params?: Params): Promise<MailPreview> {
    const kind = getMailKind(data.kind)
    if (!kind) throw new BadRequest('No such mail kind', { kind: data.kind })
    return checkTemplate(kind, data.locale, data, this.app.get('config').publicOrigin).catch(templateRefused)
  }
}

export const mailTemplates = (app: Application) => {
  app.use(MAIL_KINDS_PATH, new MailKindService(), { methods: [...MAIL_KIND_EXTERNAL_METHODS] })

  app.use(MAIL_TEMPLATES_PATH, new MailTemplateService(app), { methods: [...MAIL_TEMPLATE_EXTERNAL_METHODS] })
  app.service(MAIL_TEMPLATES_PATH).hooks({
    before: {
      find: [schemaHooks.validateQuery(mailTemplateQueryValidator)],
      patch: [schemaHooks.validateData(mailTemplatePatchValidator)]
    }
  })

  app.use(
    MAIL_TEMPLATE_REVISIONS_PATH,
    new MailTemplateRevisionService({ Model: app.get('knex'), name: 'mail_template_revisions', id: 'id', paginate: PAGINATE }),
    { methods: [...MAIL_TEMPLATE_REVISION_EXTERNAL_METHODS] }
  )
  app.service(MAIL_TEMPLATE_REVISIONS_PATH).hooks({
    around: {
      all: [
        schemaHooks.resolveExternal(mailTemplateRevisionExternalResolver),
        schemaHooks.resolveResult(mailTemplateRevisionResolver)
      ],
      create: [
        schemaHooks.validateData(mailTemplateRevisionDataValidator),
        schemaHooks.resolveData(mailTemplateRevisionDataResolver),
        saveRevision
      ]
    },
    before: {
      all: [schemaHooks.validateQuery(mailTemplateRevisionQueryValidator)],
      find: [newestFirst],
      create: [checkRevision]
    }
  })

  app.use(MAIL_PREVIEWS_PATH, new MailPreviewService(app), { methods: [...MAIL_PREVIEW_EXTERNAL_METHODS] })
  app.service(MAIL_PREVIEWS_PATH).hooks({ before: { create: [schemaHooks.validateData(mailPreviewDataValidator)] } })

  // To whoever may read the wording of the application's mail (ADR 0012).
  app.service(MAIL_TEMPLATES_PATH).publish(publishTo(app, () => [subjectChannel(MAIL_TEMPLATES_PATH)]))
  app.service(MAIL_TEMPLATE_REVISIONS_PATH).publish(publishTo(app, () => [subjectChannel(MAIL_TEMPLATE_REVISIONS_PATH)]))
}

declare module '../../app.js' {
  interface ServiceTypes {
    [MAIL_KINDS_PATH]: MailKindService
    [MAIL_TEMPLATES_PATH]: MailTemplateService
    [MAIL_TEMPLATE_REVISIONS_PATH]: MailTemplateRevisionService
    [MAIL_PREVIEWS_PATH]: MailPreviewService
  }
}
