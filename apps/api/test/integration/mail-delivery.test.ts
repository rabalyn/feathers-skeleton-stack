import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:net'
import type { AddressInfo } from 'node:net'
import { QueueEvents } from 'bullmq'
import { pino } from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Application } from '../../src/app.js'
import { queueConnection, startMaintenance, type Maintenance } from '../../src/jobs/maintenance.js'
import { PermanentMailFailure, deliver } from '../../src/mail/deliver.js'
import { exportReady } from '../../src/mail/kinds/export-ready.js'
import { createSender, isPermanentFailure, type MailSender, type Recipient } from '../../src/mail/sender.js'
import type { RenderedMail } from '../../src/mail/render.js'
import type { User } from '../../src/services/users/users.schema.js'
import { createTestApp, loadValkeyConfig } from '../support/app.js'
import { loadSmtpConfig, messageText, messagesTo } from '../support/mailpit.js'

// ADR 0027: a delivery is built, rendered in the recipient's language and
// sent now, or skipped, retried or failed, and the outcome recorded; sending
// requires TLS and is throttled across workers.

let app: Application
const knex = () => app.get('knex')
const logger = pino({ level: 'silent' })
const PUBLIC_ORIGIN = 'https://app.example.org'
const APP = { name: 'Example product', url: PUBLIC_ORIGIN }

class FakeSender implements MailSender {
  sent: { to: Recipient; mail: RenderedMail }[] = []
  failWith?: Error
  async send(to: Recipient, mail: RenderedMail) {
    if (this.failWith) throw this.failWith
    this.sent.push({ to, mail })
  }
  async verify() {}
  close() {}
}

let count = 0
const person = async (overrides: Record<string, unknown> = {}) => {
  count += 1
  const tuId = `md${String(count).padStart(2, '0')}pers`
  const user = await app
    .service('users')
    .create({ tuId, givenName: 'Erika', surname: `Muster${count}`, email: `${tuId}-${randomUUID()}@example.test`, authSource: 'saml' })
  if (Object.keys(overrides).length) await knex()('users').where({ id: user.id }).update(overrides)
  return user
}

// A ready export and its notification, committed.
const notification = async (user: User) => {
  const [row] = await knex()('dataExports')
    .insert({ subjectId: user.id, requestedBy: user.id, state: 'ready', sizeBytes: 1, sha256: 'a'.repeat(64), completedAt: knex().fn.now() })
    .returning<{ id: string }[]>('id')
  return knex().transaction((trx) => app.get('mail').notify(trx, exportReady, user.id, { exportId: row!.id }))
}

const run = (sender: MailSender, deliveryId: string, attempt = 1, attempts = 5) =>
  deliver({ knex: knex(), sender, app: APP, logger, deliveryId, attempt, attempts })

const row = (id: string) => knex()('mailDeliveries').where({ id }).first()

beforeAll(async () => {
  ;({ app } = await createTestApp())
})

afterAll(async () => {
  await app.get('mail').queue.obliterate({ force: true })
  await app.teardown()
})

describe('deliver', () => {
  it('sends in the recipient\'s language, with the active wording, and records it', async () => {
    const user = await person({ locale: 'en' })
    const id = await notification(user)
    const sender = new FakeSender()
    expect(await run(sender, id)).toEqual({ status: 'sent', kind: 'gdpr.export-ready' })
    expect(sender.sent).toHaveLength(1)
    const [{ to, mail }] = sender.sent as [{ to: Recipient; mail: RenderedMail }]
    expect(to).toEqual({ name: `Erika ${user.surname}`, address: user.email })
    expect(mail.subject).toBe('Your data export is ready')
    expect(mail.text).toContain(`Hello Erika ${user.surname}`)
    expect(mail.text).toContain(`the data export for the TU-ID ${user.tuId} you requested`)
    expect(mail.text).toContain(`${PUBLIC_ORIGIN}/profile`)
    const active = await knex()('mailTemplates').where({ kind: 'gdpr.export-ready', locale: 'en' }).first()
    expect(await row(id)).toMatchObject({ status: 'sent', revisionId: active.revisionId, attempts: 1, completedAt: expect.any(Date) })
    // Handled: a second run sends nothing.
    expect(await run(sender, id)).toEqual({ status: 'done' })
    expect(sender.sent).toHaveLength(1)
  })

  it.each([
    ['disabled', { enabled: false }],
    ['no-email', { email: null }],
    ['erased', { erasedAt: new Date() }]
  ])('skips a recipient that is %s, and says so', async (reason, overrides) => {
    const user = await person()
    const id = await notification(user)
    await knex()('users').where({ id: user.id }).update(overrides)
    const sender = new FakeSender()
    expect(await run(sender, id)).toMatchObject({ status: 'skipped', reason })
    expect(sender.sent).toEqual([])
    expect(await row(id)).toMatchObject({ status: 'skipped', skipReason: reason, revisionId: null })
  })

  it('runs the kind\'s sent hook with what was sent, once, in the transaction that records it', async () => {
    const user = await person()
    const id = await notification(user)
    const calls: { deliveryId: string; userId: string; campaignId: string | null; params: unknown; status: string }[] = []
    exportReady.sent = async (trx, mail) => {
      const { status } = await trx('mailDeliveries').where({ id: mail.deliveryId }).first('status')
      calls.push({ deliveryId: mail.deliveryId, userId: mail.userId, campaignId: mail.campaignId, params: mail.params, status })
      expect(mail.variables).toMatchObject({ requestedAt: expect.any(String), ownData: true })
    }
    try {
      expect(await run(new FakeSender(), id)).toMatchObject({ status: 'sent' })
      expect(await run(new FakeSender(), id)).toEqual({ status: 'done' })
    } finally {
      delete exportReady.sent
    }
    const { exportId } = (await row(id)).params as { exportId: string }
    expect(calls).toEqual([{ deliveryId: id, userId: user.id, campaignId: null, params: { exportId }, status: 'sent' }])
  })

  it('keeps a delivery sent when its sent hook fails, without the hook\'s writes', async () => {
    const user = await person()
    const id = await notification(user)
    exportReady.sent = async (trx, mail) => {
      await trx('mailDeliveries').where({ id: mail.deliveryId }).update({ error: 'written by the hook' })
      throw new Error('hook broke')
    }
    const sender = new FakeSender()
    try {
      expect(await run(sender, id)).toMatchObject({ status: 'sent' })
    } finally {
      delete exportReady.sent
    }
    expect(sender.sent).toHaveLength(1)
    expect(await row(id)).toMatchObject({ status: 'sent', error: null })
  })

  it('never mails the break-glass account', async () => {
    const [local] = await knex()('users').insert({ authSource: 'local', email: `bg-${randomUUID()}@example.test` }).returning<{ id: string }[]>('id')
    const [id] = await knex()('mailDeliveries').insert({ userId: local!.id, kind: 'gdpr.export-ready', params: '{}' }).returning<{ id: string }[]>('id')
    expect(await run(new FakeSender(), id!.id)).toMatchObject({ status: 'skipped', reason: 'break-glass' })
  })

  it('skips a kind no longer declared, and one whose build finds nothing to send', async () => {
    const user = await person()
    const [gone] = await knex()('mailDeliveries').insert({ userId: user.id, kind: 'old.kind', params: '{}' }).returning<{ id: string }[]>('id')
    expect(await run(new FakeSender(), gone!.id)).toMatchObject({ status: 'skipped', reason: 'unknown-kind' })
    const id = await notification(user)
    await knex()('dataExports').where({ subjectId: user.id }).delete()
    expect(await run(new FakeSender(), id)).toMatchObject({ status: 'skipped', reason: 'nothing-to-send' })
  })

  it('retries a temporary failure, and fails the delivery on the last attempt', async () => {
    const user = await person()
    const id = await notification(user)
    const sender = new FakeSender()
    sender.failWith = Object.assign(new Error('421 try later'), { responseCode: 421 })
    await expect(run(sender, id, 1, 5)).rejects.toThrow('421 try later')
    expect(await row(id)).toMatchObject({ status: 'pending', attempts: 1, error: '421 try later' })
    await expect(run(sender, id, 5, 5)).rejects.toThrow(PermanentMailFailure)
    expect(await row(id)).toMatchObject({ status: 'failed', attempts: 5, error: '421 try later' })
  })

  it('fails a permanent SMTP refusal at once', async () => {
    const user = await person()
    const id = await notification(user)
    const sender = new FakeSender()
    sender.failWith = Object.assign(new Error('550 no such mailbox'), { responseCode: 550, code: 'EENVELOPE' })
    await expect(run(sender, id, 1, 5)).rejects.toThrow(PermanentMailFailure)
    expect(await row(id)).toMatchObject({ status: 'failed', attempts: 1, error: '550 no such mailbox' })
  })

  it('fails wording that does not render for this recipient\'s data', async () => {
    const user = await person()
    const id = await notification(user)
    const [revision] = await knex()('mailTemplateRevisions')
      .insert({ kind: 'gdpr.export-ready', locale: 'de', subject: 'x', body: '{{ recipient.givenName | plus: nope }}' })
      .returning<{ id: string }[]>('id')
    const active = await knex()('mailTemplates').where({ kind: 'gdpr.export-ready', locale: 'de' }).first()
    await knex()('mailTemplates').where({ kind: 'gdpr.export-ready', locale: 'de' }).update({ revisionId: revision!.id })
    try {
      await expect(run(new FakeSender(), id)).rejects.toThrow(PermanentMailFailure)
      expect(await row(id)).toMatchObject({ status: 'failed', error: expect.stringContaining('rendering') })
    } finally {
      await knex()('mailTemplates').where({ kind: 'gdpr.export-ready', locale: 'de' }).update({ revisionId: active.revisionId })
    }
  })
})

describe('the SMTP sender', () => {
  it('sends through Mailpit over STARTTLS, verified, as the product', async () => {
    const config = await loadSmtpConfig()
    const sender = createSender(config)
    const address = `smtp-${randomUUID()}@example.test`
    try {
      await sender.send({ name: 'Erika Muster', address }, { subject: 'Über TLS', html: '<p>Hallo</p>', text: 'Hallo\n' })
    } finally {
      sender.close()
    }
    await expect.poll(() => messagesTo(address), { timeout: 10_000 }).toHaveLength(1)
    const [message] = await messagesTo(address)
    expect(message).toMatchObject({ Subject: 'Über TLS', From: { Address: config.mailFrom, Name: config.appName } })
    expect((await messageText(message!.ID)).Text).toContain('Hallo')
  })

  it('refuses a server that does not offer STARTTLS, as a temporary failure', async () => {
    // Speaks just enough SMTP to greet and answer EHLO without STARTTLS.
    const server: Server = createServer((socket) => {
      socket.write('220 plain ESMTP\r\n')
      socket.on('data', (data: Buffer) => {
        const line = data.toString()
        if (/^EHLO/i.test(line)) socket.write('250-plain\r\n250 SIZE 1000000\r\n')
        else if (/^QUIT/i.test(line)) socket.end('221 bye\r\n')
        else socket.write('502 no\r\n')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const config = await loadSmtpConfig()
    const sender = createSender({ ...config, smtpHost: '127.0.0.1', smtpPort: (server.address() as AddressInfo).port })
    try {
      const error = await sender.send({ name: 'x', address: 'x@example.test' }, { subject: 's', html: 'h', text: 't' }).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(Error)
      expect(isPermanentFailure(error)).toBe(false)
    } finally {
      sender.close()
      server.close()
    }
  })
})

describe('the mail queue', () => {
  let maintenance: Maintenance
  let events: QueueEvents
  const sender = new FakeSender()

  beforeAll(async () => {
    const connection = queueConnection(await loadValkeyConfig())
    maintenance = startMaintenance({
      connection,
      knex: knex(),
      settings: app.get('settings'),
      storage: app.get('storage'),
      exports: app.get('exports'),
      logger,
      prefix: `test-${randomUUID()}`,
      mail: { sender, app: APP }
    })
    events = new QueueEvents(maintenance.mail.queue.name, { connection, prefix: maintenance.mail.queue.opts.prefix })
    await events.waitUntilReady()
  })

  afterAll(async () => {
    await events.close()
    for (const queue of [maintenance.queue, maintenance.exportQueue, maintenance.mail.queue]) await queue.obliterate({ force: true })
    await maintenance.close()
    const setSetting = (key: string, value: unknown) => knex()('settings').where({ key }).update({ value: JSON.stringify(value) })
    await setSetting('mailSendLimitCount', 10)
    await setSetting('mailSendLimitWindowSeconds', 300)
  })

  it('sends no more than the limit per window, across the queue', async () => {
    await knex()('settings').where({ key: 'mailSendLimitCount' }).update({ value: JSON.stringify(2) })
    await knex()('settings').where({ key: 'mailSendLimitWindowSeconds' }).update({ value: JSON.stringify(60) })
    await maintenance.schedule()
    const users = await Promise.all([person(), person(), person(), person()])
    const ids = await Promise.all(users.map((user) => notification(user)))
    await maintenance.mail.enqueue(ids)
    await expect.poll(() => sender.sent.length, { timeout: 10_000 }).toBe(2)
    // The rest wait for the next window.
    await new Promise((resolve) => setTimeout(resolve, 2000))
    expect(sender.sent).toHaveLength(2)
    expect(await knex()('mailDeliveries').whereIn('id', ids).where({ status: 'pending' })).toHaveLength(2)
  })
})
