import type { Knex } from 'knex'
import type { Logger } from 'pino'
import { DEFAULT_LOCALE, LOCALES, type Locale } from '../locales.js'
import type { AppVariables } from './kind.js'
import { getMailKind } from './registry.js'
import { renderMail, type RenderedMail } from './render.js'
import { isPermanentFailure, type MailSender } from './sender.js'

// One delivery (ADR 0027): who it goes to, in which wording, built and
// rendered now, sent, and the outcome recorded on its row. At least once: a
// worker that dies after the relay accepted a mail but before recording it
// sends it again.

export type SkipReason = 'disabled' | 'erased' | 'no-email' | 'break-glass' | 'unknown-kind' | 'nothing-to-send'

export type DeliveryOutcome =
  | { status: 'sent'; kind: string }
  | { status: 'skipped'; kind: string; reason: SkipReason }
  // Handled already: sent, skipped or failed by an earlier run, or gone.
  | { status: 'done' }

// Thrown for a failure no retry can fix; the delivery is already `failed`.
export class PermanentMailFailure extends Error {
  constructor(
    message: string,
    readonly kind: string
  ) {
    super(message)
  }
}

interface DeliveryRow {
  id: string
  userId: string
  kind: string
  campaignId: string | null
  params: Record<string, unknown>
  status: string
}

interface RecipientRow {
  givenName: string | null
  surname: string | null
  email: string | null
  enabled: boolean
  authSource: string
  erasedAt: Date | null
  locale: string
}

export interface DeliverOptions {
  knex: Knex
  sender: MailSender
  // `app` in the mail: the product's name and origin.
  app: AppVariables
  logger: Logger
  deliveryId: string
  // This attempt, from 1, and how many there are.
  attempt: number
  attempts: number
}

const skipReason = (user: RecipientRow | undefined): SkipReason | undefined => {
  if (!user || user.erasedAt) return 'erased'
  if (user.authSource === 'local') return 'break-glass'
  if (!user.enabled) return 'disabled'
  if (!user.email) return 'no-email'
  return undefined
}

// The wording: the revision a campaign pinned when it was sent, or the
// template active now.
const revisionFor = async (knex: Knex, delivery: DeliveryRow, locale: Locale) => {
  const pinned = delivery.campaignId
    ? knex('mailCampaignRevisions').where({ campaignId: delivery.campaignId, locale })
    : knex('mailTemplates').where({ kind: delivery.kind, locale })
  const revisionId = (await pinned.first<{ revisionId: string } | undefined>('revisionId'))?.revisionId
  if (!revisionId) return undefined
  return knex('mailTemplateRevisions')
    .where({ id: revisionId })
    .first<{ id: string; subject: string; body: string } | undefined>('id', 'subject', 'body')
}

const complete = (knex: Knex, id: string, attempt: number, update: Record<string, unknown>) =>
  knex('mailDeliveries')
    .where({ id, status: 'pending' })
    .update({ ...update, attempts: attempt, completedAt: knex.fn.now() })

export const deliver = async ({
  knex,
  sender,
  app,
  logger,
  deliveryId,
  attempt,
  attempts
}: DeliverOptions): Promise<DeliveryOutcome> => {
  const delivery = await knex('mailDeliveries').where({ id: deliveryId }).first<DeliveryRow | undefined>()
  if (!delivery || delivery.status !== 'pending') return { status: 'done' }

  const skip = async (reason: SkipReason): Promise<DeliveryOutcome> => {
    await complete(knex, deliveryId, attempt, { status: 'skipped', skipReason: reason })
    logger.info({ delivery_id: deliveryId, kind: delivery.kind, reason }, 'mail skipped')
    return { status: 'skipped', kind: delivery.kind, reason }
  }
  const fail = async (message: string): Promise<never> => {
    await complete(knex, deliveryId, attempt, { status: 'failed', error: message.slice(0, 2000) })
    logger.error({ delivery_id: deliveryId, kind: delivery.kind, err: { message } }, 'mail failed')
    throw new PermanentMailFailure(message, delivery.kind)
  }

  const kind = getMailKind(delivery.kind)
  if (!kind) return skip('unknown-kind')
  const user = await knex('users')
    .where({ id: delivery.userId })
    .first<RecipientRow | undefined>('givenName', 'surname', 'email', 'enabled', 'authSource', 'erasedAt', 'locale')
  const reason = skipReason(user)
  if (reason) return skip(reason)
  const recipient = user!
  const locale = (LOCALES as readonly string[]).includes(recipient.locale) ? (recipient.locale as Locale) : DEFAULT_LOCALE

  const variables = await kind.build(knex, delivery.userId, delivery.params)
  if (variables === null) return skip('nothing-to-send')
  const revision = await revisionFor(knex, delivery, locale)
  if (!revision) return fail(`no template for ${kind.key} in ${locale}`)

  let mail: RenderedMail
  try {
    mail = await renderMail({
      locale,
      subject: revision.subject,
      body: revision.body,
      variables: {
        ...variables,
        recipient: { givenName: recipient.givenName ?? '', surname: recipient.surname ?? '' },
        app
      }
    })
  } catch (error) {
    // The wording passed its check against the sample; this recipient's
    // data does not render. No retry changes that.
    return fail(`rendering: ${(error as Error).message}`)
  }

  const name = [recipient.givenName, recipient.surname].filter(Boolean).join(' ')
  try {
    await sender.send({ name, address: recipient.email! }, mail)
  } catch (error) {
    const message = (error as Error).message
    if (isPermanentFailure(error) || attempt >= attempts) return fail(message)
    await knex('mailDeliveries').where({ id: deliveryId, status: 'pending' }).update({ attempts: attempt, error: message.slice(0, 2000) })
    throw error
  }
  await knex.transaction(async (trx) => {
    const recorded = await complete(trx, deliveryId, attempt, { status: 'sent', revisionId: revision.id, error: null })
    if (!recorded || !kind.sent) return
    const sent = { deliveryId, userId: delivery.userId, campaignId: delivery.campaignId, params: delivery.params, variables }
    // In a savepoint: the mail is out, so a failing hook must not undo its
    // record and have it sent again.
    await trx.transaction((savepoint) => kind.sent!(savepoint, sent)).catch((error: Error) =>
      logger.error({ delivery_id: deliveryId, kind: kind.key, err: { message: error.message } }, 'mail sent hook failed')
    )
  })
  return { status: 'sent', kind: kind.key }
}
