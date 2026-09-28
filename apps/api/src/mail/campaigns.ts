import { getValidator, type TObject } from '@feathersjs/typebox'
import type { Knex } from 'knex'
import { LOCALES, type Locale } from '../locales.js'
import { dataValidator } from '../validators.js'
import type { CampaignKind } from './kind.js'
import type { MailOutbox } from './outbox.js'
import { getMailKind } from './registry.js'
import { renderMail, type RenderedMail } from './render.js'
import { appVariables } from './templates.js'

// Campaigns (ADR 0027): an admin picks a campaign kind, fills its
// parameters, sees how many people it reaches and how it reads for one of
// them, and sends it. The worker resolves the recipients into deliveries.

export class CampaignError extends Error {}

const validators = new WeakMap<TObject, ReturnType<typeof getValidator>>()

export const campaignKind = (key: string): CampaignKind => {
  const kind = getMailKind(key)
  if (!kind || kind.type !== 'campaign') throw new CampaignError(`${key} is not a campaign`)
  return kind
}

// The admin's choices, checked against the kind's params schema; returns
// the error text, if any.
export const campaignParamsError = async (kind: CampaignKind, params: unknown): Promise<string | undefined> => {
  let validate = validators.get(kind.params)
  if (!validate) {
    validate = getValidator(kind.params, dataValidator)
    validators.set(kind.params, validate)
  }
  try {
    await validate(params)
    return undefined
  } catch (error) {
    const errors = (error as { data?: { instancePath?: string; message?: string }[] }).data ?? []
    return errors.map((each) => `${each.instancePath || 'params'} ${each.message ?? 'is invalid'}`).join('; ') || 'invalid params'
  }
}

// How long sending `count` mails takes at the sending limit: the first
// window's worth leaves at once, each further one a window later.
export const estimatedSeconds = (count: number, limitCount: number, windowSeconds: number) =>
  count <= limitCount ? 0 : (Math.ceil(count / limitCount) - 1) * windowSeconds

export interface CampaignPreview {
  recipientCount: number
  estimatedSeconds: number
  // The person the preview is rendered for; null when nobody is reached.
  recipient: { id: string; givenName: string; surname: string } | null
  previews: Record<Locale, RenderedMail> | null
}

// How many people the campaign reaches, and how its active wording reads
// for the first of them who would get a mail, in each locale.
export const previewCampaign = async (
  knex: Knex,
  kind: CampaignKind,
  params: Record<string, unknown>,
  publicOrigin: string,
  limit: { count: number; windowSeconds: number }
): Promise<CampaignPreview> => {
  const recipients = () => kind.recipients(knex, params).as('r')
  const [counted] = await knex.from(recipients()).count<{ count: string }[]>({ count: '*' })
  const recipientCount = Number(counted?.count ?? 0)
  const base = { recipientCount, estimatedSeconds: estimatedSeconds(recipientCount, limit.count, limit.windowSeconds) }

  // The first few who would actually be mailed.
  const candidates = await knex
    .from(recipients())
    .join('users as u', 'u.id', 'r.id')
    .where({ 'u.enabled': true, 'u.authSource': 'saml' })
    .whereNull('u.erasedAt')
    .whereNotNull('u.email')
    .orderBy('u.surname')
    .orderBy('u.id')
    .limit(20)
    .select<{ id: string; givenName: string | null; surname: string | null }[]>('u.id', 'u.givenName', 'u.surname')
  const revisions = await knex('mailTemplates as t')
    .join('mailTemplateRevisions as v', 'v.id', 't.revisionId')
    .where('t.kind', kind.key)
    .select<{ locale: Locale; subject: string; body: string }[]>('t.locale', 'v.subject', 'v.body')
  for (const candidate of candidates) {
    const variables = await kind.build(knex, candidate.id, params)
    if (variables === null) continue
    const recipient = { givenName: candidate.givenName ?? '', surname: candidate.surname ?? '' }
    const previews = {} as Record<Locale, RenderedMail>
    for (const locale of LOCALES) {
      const revision = revisions.find((each) => each.locale === locale)
      if (!revision) throw new CampaignError(`no template for ${kind.key} in ${locale}`)
      previews[locale] = await renderMail({
        locale,
        subject: revision.subject,
        body: revision.body,
        variables: { ...variables, recipient, app: appVariables(publicOrigin) }
      })
    }
    return { ...base, recipient: { id: candidate.id, ...recipient }, previews }
  }
  return { ...base, recipient: null, previews: null }
}

// Writes the campaign row, pinning the active revision of every locale.
// Takes the transaction the audit event shares. Returns the campaign's id.
export const createCampaign = async (
  trx: Knex.Transaction,
  kind: CampaignKind,
  params: Record<string, unknown>,
  sentBy: string
): Promise<string> => {
  const active = await trx('mailTemplates')
    .where({ kind: kind.key })
    .forShare()
    .select<{ locale: Locale; revisionId: string }[]>('locale', 'revisionId')
  for (const locale of LOCALES) {
    if (!active.some((each) => each.locale === locale)) throw new CampaignError(`no template for ${kind.key} in ${locale}`)
  }
  const [row]: { id: string }[] = await trx('mailCampaigns')
    .insert({ kind: kind.key, params: JSON.stringify(params), sentBy })
    .returning('id')
  await trx('mailCampaignRevisions').insert(active.map((each) => ({ campaignId: row!.id, locale: each.locale, revisionId: each.revisionId })))
  return row!.id
}

export interface ResolveResult {
  campaignId: string
  state: 'queued' | 'skipped'
  recipients?: number
}

// The worker's part: one delivery per recipient, then their jobs. A rerun
// adds no duplicates; what a crash left unenqueued, the sweep enqueues.
export const resolveCampaign = async (knex: Knex, outbox: MailOutbox, campaignId: string): Promise<ResolveResult> => {
  const { ids, recipients } = await knex.transaction(async (trx) => {
    const campaign = await trx('mailCampaigns')
      .where({ id: campaignId, status: 'pending' })
      .forUpdate()
      .first<{ kind: string; params: Record<string, unknown> } | undefined>('kind', 'params')
    if (!campaign) return { ids: [], recipients: undefined }
    const kind = getMailKind(campaign.kind)
    let ids: string[] = []
    if (kind?.type === 'campaign') {
      const result = await trx.raw<{ rows: { id: string }[] }>(
        `INSERT INTO mail_deliveries (user_id, kind, campaign_id, params)
         SELECT DISTINCT r.id, ?, ?::uuid, ?::jsonb FROM ? AS r
         ON CONFLICT (campaign_id, user_id) DO NOTHING
         RETURNING id`,
        [kind.key, campaignId, JSON.stringify(campaign.params), kind.recipients(trx, campaign.params)]
      )
      ids = result.rows.map((row) => row.id)
    }
    const [counted] = await trx('mailDeliveries').where({ campaignId }).count<{ count: string }[]>({ count: '*' })
    const recipients = Number(counted?.count ?? 0)
    await trx('mailCampaigns').where({ id: campaignId }).update({ status: 'queued', recipientCount: recipients, queuedAt: trx.fn.now() })
    return { ids, recipients }
  })
  if (recipients === undefined) return { campaignId, state: 'skipped' }
  await outbox.enqueue(ids)
  return { campaignId, state: 'queued', recipients }
}
