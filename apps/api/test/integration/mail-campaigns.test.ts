import { pino } from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Application } from '../../src/app.js'
import { estimatedSeconds, resolveCampaign } from '../../src/mail/campaigns.js'
import { deliver } from '../../src/mail/deliver.js'
import type { MailSender, Recipient } from '../../src/mail/sender.js'
import type { RenderedMail } from '../../src/mail/render.js'
import type { User } from '../../src/services/users/users.schema.js'
import { createTestApp } from '../support/app.js'

// ADR 0027: an admin previews a campaign for an actual recipient, sends it
// by hand, and what goes out is the wording previewed; the worker resolves
// the recipients once, however often it runs. ADR 0011: admins only.

let app: Application
let admin: User
let operator: User
const people: User[] = []
const knex = () => app.get('knex')
const as = (user: User) => ({ provider: 'rest' as const, user, authenticated: true })
const KIND = 'documents.stale-reminder'
// Older than anything another test file creates.
const PARAMS = { olderThanDays: 3000 }

const make = async (tuId: string, givenName: string, surname: string, role: User['role'] = 'user') => {
  const created = await app.service('users').create({ tuId, givenName, surname, email: `${tuId}@example.test`, authSource: 'saml' })
  return role === 'user' ? created : app.service('users').patch(created.id, { role })
}

const oldDocument = async (owner: User, title: string) => {
  const [file] = await knex()('files')
    .insert({ ownerId: owner.id, filename: 'a.pdf', contentType: 'application/pdf', sizeBytes: 1, sha256: 'b'.repeat(64), state: 'stored' })
    .returning<{ id: string }[]>('id')
  await knex()('documents').insert({ ownerId: owner.id, title, fileId: file!.id, updatedAt: knex().raw(`now() - interval '9 years'`) })
}

beforeAll(async () => {
  ;({ app } = await createTestApp())
  admin = await make('mc01admn', 'Ada', 'Admin', 'admin')
  operator = await make('mc02oper', 'Otto', 'Operator', 'operator')
  const anna = await make('mc03anna', 'Anna', 'Albers')
  const bert = await make('mc04bert', 'Bert', 'Berger')
  const gone = await make('mc05gone', 'Gina', 'Gone')
  await knex()('users').where({ id: bert.id }).update({ locale: 'en' })
  await knex()('users').where({ id: gone.id }).update({ enabled: false })
  await oldDocument(anna, 'Antrag <Labor>')
  await oldDocument(anna, 'Protokoll')
  await oldDocument(bert, 'Minutes')
  await oldDocument(gone, 'Alt')
  people.push(anna, bert, gone)
})

afterAll(async () => {
  await app.get('mail').queue.obliterate({ force: true })
  await app.get('mail').campaigns.obliterate({ force: true })
  await app.teardown()
})

describe('campaign preview', () => {
  it('counts the recipients, estimates the duration and renders for an actual recipient in each locale', async () => {
    const preview = await app.service('mail-campaign-previews').create({ kind: KIND, params: PARAMS }, as(admin))
    expect(preview).toMatchObject({ kind: KIND, recipientCount: 3, estimatedSeconds: 0 })
    // Anna Albers comes first, and gets a mail; the disabled account would not.
    expect(preview.recipient).toMatchObject({ id: people[0]!.id, givenName: 'Anna', surname: 'Albers' })
    expect(preview.previews!.de!.subject).toBe('Ihre Dokumente wurden länger nicht bearbeitet')
    expect(preview.previews!.de!.text).toContain('Hallo Anna Albers')
    expect(preview.previews!.de!.text).toContain('- Antrag <Labor>, zuletzt geändert am')
    expect(preview.previews!.de!.html).toContain('Antrag &lt;Labor&gt;')
    expect(preview.previews!.en!.text).toContain('these 2 documents have not been changed for more than 3,000 days')
  })

  it('says when nobody is reached', async () => {
    const preview = await app.service('mail-campaign-previews').create({ kind: KIND, params: { olderThanDays: 3650 } }, as(admin))
    expect(preview).toMatchObject({ recipientCount: 0, recipient: null, previews: null })
  })

  it('estimates the time at the sending limit', () => {
    expect(estimatedSeconds(10, 10, 300)).toBe(0)
    expect(estimatedSeconds(11, 10, 300)).toBe(300)
    // The expected maximum: a little over two hours (ADR 0027).
    expect(estimatedSeconds(250, 10, 300)).toBe(7200)
  })

  it.each([
    ['parameters the kind does not accept', { kind: KIND, params: { olderThanDays: 0 } }],
    ['parameters the kind does not declare', { kind: KIND, params: { olderThanDays: 5, extra: true } }],
    ['a notification', { kind: 'gdpr.export-ready', params: { exportId: '0190f0f0-0000-7000-8000-000000000000' } }],
    ['an unknown kind', { kind: 'nope.kind', params: {} }]
  ])('refuses %s', async (_what, data) => {
    // Fresh objects: authorization marks each with its service.
    await expect(app.service('mail-campaign-previews').create(structuredClone(data), as(admin))).rejects.toMatchObject({ code: 400 })
    await expect(app.service('mail-campaigns').create(structuredClone(data), as(admin))).rejects.toMatchObject({ code: 400 })
  })
})

describe('sending a campaign', () => {
  it('pins the wording previewed, audits, and resolves each recipient once', async () => {
    const active = await app.service('mail-templates').find({ query: { kind: KIND } })
    const campaign = await app.service('mail-campaigns').create({ kind: KIND, params: PARAMS }, as(admin))
    expect(campaign).toMatchObject({ kind: KIND, params: PARAMS, sentBy: admin.id, status: 'pending', recipientCount: null })
    expect(campaign.revisions).toEqual(Object.fromEntries(active.map((template) => [template.locale, template.revisionId])))
    expect(await knex()('auditEvents').where({ action: 'mail.campaign.send', resourceId: campaign.id })).toEqual([
      expect.objectContaining({ actorId: admin.id, detail: { kind: KIND, params: PARAMS } })
    ])
    // Handed to the worker, under the campaign's id.
    expect(await app.get('mail').campaigns.getJob(campaign.id)).toBeDefined()

    // Edited after sending: the campaign keeps what was previewed.
    await app
      .service('mail-template-revisions')
      .create({ kind: KIND, locale: 'de', subject: 'Neuer Betreff', body: 'Neu' }, as(admin))

    const first = await resolveCampaign(knex(), app.get('mail'), campaign.id)
    expect(first).toEqual({ campaignId: campaign.id, state: 'queued', recipients: 3 })
    expect(await resolveCampaign(knex(), app.get('mail'), campaign.id)).toEqual({ campaignId: campaign.id, state: 'skipped' })
    const deliveries = await knex()('mailDeliveries').where({ campaignId: campaign.id })
    expect(deliveries.map((row: { userId: string }) => row.userId).sort()).toEqual(people.map((person) => person.id).sort())
    expect(deliveries.every((row: { params: unknown; status: string }) => row.status === 'pending')).toBe(true)
    const queued = await app.service('mail-campaigns').get(campaign.id, as(admin))
    expect(queued).toMatchObject({ status: 'queued', recipientCount: 3, progress: { pending: 3, sent: 0, failed: 0, skipped: 0 } })

    const sent: { to: Recipient; mail: RenderedMail }[] = []
    const sender: MailSender = { send: async (to, mail) => void sent.push({ to, mail }), verify: async () => {}, close: () => {} }
    for (const row of deliveries as { id: string }[]) {
      await deliver({ knex: knex(), sender, publicOrigin: 'https://app.example.org', logger: pino({ level: 'silent' }), deliveryId: row.id, attempt: 1, attempts: 5 })
    }
    expect(sent.map(({ mail }) => mail.subject).sort()).toEqual([
      'Ihre Dokumente wurden länger nicht bearbeitet',
      'Your documents have not been changed for a while'
    ])
    expect(sent.some(({ mail }) => mail.subject === 'Neuer Betreff')).toBe(false)
    expect(await app.service('mail-campaigns').get(campaign.id, as(admin))).toMatchObject({
      progress: { pending: 0, sent: 2, failed: 0, skipped: 1 }
    })
    await app.service('mail-templates').patch(`${KIND}:de`, { revisionId: campaign.revisions.de! })
  })

  it('lists campaigns newest first', async () => {
    const page = await app.service('mail-campaigns').find(as(admin))
    expect(page.data[0]).toMatchObject({ kind: KIND, sentBy: admin.id })
  })
})

describe('campaigns: admins only (ADR 0011)', () => {
  it.each([
    ['operator', () => operator],
    ['user', () => people[0]!]
  ])('%s neither previews, sends nor sees campaigns', async (_role, who) => {
    await expect(app.service('mail-campaign-previews').create({ kind: KIND, params: PARAMS }, as(who()))).rejects.toMatchObject({ code: 403 })
    await expect(app.service('mail-campaigns').create({ kind: KIND, params: PARAMS }, as(who()))).rejects.toMatchObject({ code: 403 })
    await expect(app.service('mail-campaigns').find(as(who()))).rejects.toMatchObject({ code: 403 })
  })
})
