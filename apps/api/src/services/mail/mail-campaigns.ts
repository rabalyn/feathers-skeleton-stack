import { BadRequest } from '@feathersjs/errors'
import type { NextFunction, Params } from '@feathersjs/feathers'
import { KnexService } from '@feathersjs/knex'
import { hooks as schemaHooks } from '@feathersjs/schema'
import type { Application } from '../../app.js'
import { recordAudit } from '../../audit.js'
import { publishNothing, publishTo, subjectChannel } from '../../channels.js'
import type { HookContext } from '../../declarations.js'
import { CampaignError, campaignKind, campaignParamsError, createCampaign, previewCampaign } from '../../mail/campaigns.js'
import type { CampaignKind } from '../../mail/kind.js'
import { TemplateError } from '../../mail/render.js'
import { PAGINATE } from '../../paginate.js'
import {
  mailCampaignDataValidator,
  mailCampaignExternalResolver,
  mailCampaignPreviewDataValidator,
  mailCampaignQueryValidator,
  mailCampaignResolver,
  type MailCampaign,
  type MailCampaignData,
  type MailCampaignPreview,
  type MailCampaignPreviewData,
  type MailCampaignQuery
} from './mail.schema.js'

// Campaigns (ADR 0027), sent by an admin and only by hand: the Mailings page
// previews one for an actual recipient, then sends it. The campaign row,
// its pinned revisions and the audit event commit together; the worker then
// resolves the recipients. There is no scheduled sending, by decision.

export const MAIL_CAMPAIGNS_PATH = 'mail-campaigns'
export const MAIL_CAMPAIGN_PREVIEWS_PATH = 'mail-campaign-previews'
export const MAIL_CAMPAIGN_EXTERNAL_METHODS = ['find', 'get', 'create'] as const
export const MAIL_CAMPAIGN_PREVIEW_EXTERNAL_METHODS = ['create'] as const

export type MailCampaignParams = Params<MailCampaignQuery>

export class MailCampaignService extends KnexService<MailCampaign, MailCampaignData, MailCampaignParams> {}

// A campaign kind declared in code, with parameters its schema accepts.
const checkedKind = async (data: { kind: string; params: Record<string, unknown> }): Promise<CampaignKind> => {
  let kind: CampaignKind
  try {
    kind = campaignKind(data.kind)
  } catch (error) {
    if (error instanceof CampaignError) throw new BadRequest('No such campaign', { kind: data.kind })
    throw error
  }
  const invalid = await campaignParamsError(kind, data.params)
  if (invalid) throw new BadRequest('Invalid campaign parameters', { errors: [{ message: invalid }] })
  return kind
}

const sendCampaign = async (context: HookContext<MailCampaignService>, next: NextFunction) => {
  const data = context.data as MailCampaignData
  const kind = await checkedKind(data)
  const actorId = context.params.user?.id
  if (!actorId) throw new BadRequest('A campaign is sent by a person')
  const app = context.app
  const campaignId = await app.get('knex').transaction(async (trx) => {
    const id = await createCampaign(trx, kind, data.params, actorId).catch((error: unknown) => {
      if (error instanceof CampaignError) throw new BadRequest(error.message)
      throw error
    })
    await recordAudit(trx, {
      actorId,
      action: 'mail.campaign.send',
      resourceType: MAIL_CAMPAIGNS_PATH,
      resourceId: id,
      detail: { kind: kind.key, params: data.params }
    })
    return id
  })
  // Committed: a lost enqueue is picked up by the sweep within minutes.
  await app
    .get('mail')
    .enqueueCampaign(campaignId)
    .catch((error: Error) =>
      app.get('logger').warn({ campaign_id: campaignId, err: { message: error.message } }, 'campaign not enqueued; the sweep will')
    )
  context.result = await context.service._get(campaignId)
  await next()
}

const newestFirst = async (context: HookContext<MailCampaignService>) => {
  const query = context.params.query ?? {}
  if (!query.$sort) context.params.query = { ...query, $sort: { createdAt: -1, id: -1 } }
}

export class MailCampaignPreviewService {
  constructor(private readonly app: Application) {}

  async create(data: MailCampaignPreviewData, _params?: Params): Promise<MailCampaignPreview> {
    const kind = await checkedKind(data)
    const settings = this.app.get('settings')
    const [count, windowSeconds] = await Promise.all([settings.get('mailSendLimitCount'), settings.get('mailSendLimitWindowSeconds')])
    try {
      const preview = await previewCampaign(this.app.get('knex'), kind, data.params, this.app.get('config').publicOrigin, {
        count,
        windowSeconds
      })
      return { kind: kind.key, ...preview }
    } catch (error) {
      if (error instanceof CampaignError || error instanceof TemplateError) {
        throw new BadRequest('The campaign cannot be previewed', { errors: [{ message: error.message }] })
      }
      throw error
    }
  }
}

export const mailCampaigns = (app: Application) => {
  app.use(
    MAIL_CAMPAIGNS_PATH,
    new MailCampaignService({ Model: app.get('knex'), name: 'mail_campaigns', id: 'id', paginate: PAGINATE }),
    { methods: [...MAIL_CAMPAIGN_EXTERNAL_METHODS] }
  )
  app.service(MAIL_CAMPAIGNS_PATH).hooks({
    around: {
      all: [schemaHooks.resolveExternal(mailCampaignExternalResolver), schemaHooks.resolveResult(mailCampaignResolver)],
      create: [schemaHooks.validateData(mailCampaignDataValidator), sendCampaign]
    },
    before: {
      all: [schemaHooks.validateQuery(mailCampaignQueryValidator)],
      find: [newestFirst]
    }
  })
  // To whoever may read campaigns (ADR 0011, 0012).
  app.service(MAIL_CAMPAIGNS_PATH).publish(publishTo(app, () => [subjectChannel(MAIL_CAMPAIGNS_PATH)]))

  app.use(MAIL_CAMPAIGN_PREVIEWS_PATH, new MailCampaignPreviewService(app), {
    methods: [...MAIL_CAMPAIGN_PREVIEW_EXTERNAL_METHODS]
  })
  app.service(MAIL_CAMPAIGN_PREVIEWS_PATH).hooks({
    before: { create: [schemaHooks.validateData(mailCampaignPreviewDataValidator)] }
  })
  // A preview is for the caller only.
  app.service(MAIL_CAMPAIGN_PREVIEWS_PATH).publish(publishNothing)
}

declare module '../../app.js' {
  interface ServiceTypes {
    [MAIL_CAMPAIGNS_PATH]: MailCampaignService
    [MAIL_CAMPAIGN_PREVIEWS_PATH]: MailCampaignPreviewService
  }
}
