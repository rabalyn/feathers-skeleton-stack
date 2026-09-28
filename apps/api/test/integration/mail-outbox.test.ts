import { UnrecoverableError, Worker } from 'bullmq'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Application } from '../../src/app.js'
import { buildExport } from '../../src/gdpr/export.js'
import { MAIL_QUEUE, queueConnection } from '../../src/jobs/queues.js'
import { defineMailKind } from '../../src/mail/kind.js'
import { exportReady } from '../../src/mail/kinds/export-ready.js'
import { MailError } from '../../src/mail/outbox.js'
import type { User } from '../../src/services/users/users.schema.js'
import { createTestApp } from '../support/app.js'

// ADR 0024, 0027: a notification exists exactly when the write that causes
// it commits, is enqueued after the commit under the delivery's id, and the
// sweep enqueues what a lost enqueue left pending.

let app: Application
let member: User
const knex = () => app.get('knex')
const mail = () => app.get('mail')

beforeAll(async () => {
  ;({ app } = await createTestApp())
  member = await app
    .service('users')
    .create({ tuId: 'mo01user', givenName: 'Mo', surname: 'Outbox', email: 'mo01user@example.test', authSource: 'saml' })
})

afterAll(async () => {
  await mail().queue.obliterate({ force: true })
  await app.teardown()
})

const exportRow = async () => {
  const [row] = await knex()('dataExports').insert({ subjectId: member.id, requestedBy: member.id }).returning<{ id: string }[]>('id')
  return row!.id
}

// A pending export blocks the next (one per person): finish each.
const finish = (exportId: string) => knex()('dataExports').where({ id: exportId }).update({ state: 'failed' })

describe('mail.notify', () => {
  it('writes a pending delivery in the transaction and enqueues it once committed', async () => {
    const exportId = await exportRow()
    const deliveryId = await knex().transaction((trx) => mail().notify(trx, exportReady, member.id, { exportId }))
    await finish(exportId)
    expect(await knex()('mailDeliveries').where({ id: deliveryId }).first()).toMatchObject({
      userId: member.id,
      kind: 'gdpr.export-ready',
      params: { exportId },
      status: 'pending',
      campaignId: null
    })
    await expect.poll(async () => (await mail().queue.getJob(deliveryId))?.data).toEqual({ deliveryId })
  })

  it('leaves nothing behind for a write that rolls back', async () => {
    const exportId = await exportRow()
    let deliveryId = ''
    await expect(
      knex().transaction(async (trx) => {
        deliveryId = await mail().notify(trx, exportReady, member.id, { exportId })
        throw new Error('the write fails')
      })
    ).rejects.toThrow('the write fails')
    await finish(exportId)
    expect(await knex()('mailDeliveries').where({ id: deliveryId }).first()).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(await mail().queue.getJob(deliveryId)).toBeUndefined()
  })

  it('refuses params its kind does not declare, and kinds not registered', async () => {
    await expect(
      knex().transaction((trx) => mail().notify(trx, exportReady, member.id, { exportId: 'not-a-uuid' }))
    ).rejects.toThrow(MailError)
    const stray = defineMailKind({ ...exportReady, key: 'test.stray' })
    const exportId = await exportRow()
    await expect(knex().transaction((trx) => mail().notify(trx, stray, member.id, { exportId }))).rejects.toThrow(/not registered/)
    await finish(exportId)
  })

  it('is sent by the worker when an export becomes ready, to the account that asked for it', async () => {
    const exportId = await exportRow()
    const result = await buildExport({ knex: knex(), uploads: app.get('storage'), exports: app.get('exports'), exportId, mail: mail() })
    expect(result.state).toBe('ready')
    expect(await knex()('mailDeliveries').where({ kind: 'gdpr.export-ready' }).whereRaw(`params->>'exportId' = ?`, [exportId])).toEqual([
      expect.objectContaining({ userId: member.id, status: 'pending' })
    ])
    await app.get('exports').delete(exportId)
  })
})

describe('the outbox sweep', () => {
  it('enqueues deliveries pending for over a minute whose job is lost, once', async () => {
    const exportId = await exportRow()
    const [lost] = await knex()('mailDeliveries')
      .insert({ userId: member.id, kind: 'gdpr.export-ready', params: JSON.stringify({ exportId }), createdAt: knex().raw(`now() - interval '2 minutes'`) })
      .returning<{ id: string }[]>('id')
    const [recent] = await knex()('mailDeliveries')
      .insert({ userId: member.id, kind: 'gdpr.export-ready', params: JSON.stringify({ exportId }) })
      .returning<{ id: string }[]>('id')
    await finish(exportId)

    await mail().sweep(knex())
    expect(await mail().queue.getJob(lost!.id)).toBeDefined()
    // Not yet: its own enqueue may still be under way.
    expect(await mail().queue.getJob(recent!.id)).toBeUndefined()

    // A job that exists is not added twice.
    const before = await mail().queue.getJobCountByTypes('waiting', 'delayed', 'active', 'completed', 'failed')
    await mail().sweep(knex())
    expect(await mail().queue.getJobCountByTypes('waiting', 'delayed', 'active', 'completed', 'failed')).toBe(before)
  })

  it('runs a failed job again while its delivery is still pending', async () => {
    const exportId = await exportRow()
    const [row] = await knex()('mailDeliveries')
      .insert({ userId: member.id, kind: 'gdpr.export-ready', params: JSON.stringify({ exportId }), createdAt: knex().raw(`now() - interval '2 minutes'`) })
      .returning<{ id: string }[]>('id')
    await finish(exportId)
    // Its last attempt failed, and so did recording that.
    const worker = new Worker(
      MAIL_QUEUE,
      async (job) => {
        if (job.id === row!.id) throw new UnrecoverableError('and the database was gone')
      },
      { connection: queueConnection(app.get('config')), prefix: app.get('config').queuePrefix }
    )
    await mail().enqueue([row!.id])
    await expect.poll(async () => (await mail().queue.getJob(row!.id))?.getState()).toBe('failed')
    await worker.close()
    await mail().sweep(knex())
    expect(await (await mail().queue.getJob(row!.id))?.getState()).toBe('waiting')
  })
})

describe('the delivery log under erasure (ADR 0013)', () => {
  it('is deleted with the person', async () => {
    const person = await app
      .service('users')
      .create({ tuId: 'mo02gone', givenName: 'Gone', surname: 'Soon', email: 'mo02gone@example.test', authSource: 'saml' })
    await knex()('mailDeliveries').insert({ userId: person.id, kind: 'gdpr.export-ready', params: '{}' })
    await knex().raw('SELECT erase_user(?)', [person.id])
    expect(await knex()('mailDeliveries').where({ userId: person.id })).toEqual([])
  })
})
