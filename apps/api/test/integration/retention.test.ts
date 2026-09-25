import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Application } from '../../src/app.js'
import { retentionCleanup } from '../../src/jobs/retention.js'
import { createTestApp } from '../support/app.js'

// ADR 0013, 0024: retention cleanup deletes what is past its retention and
// nothing else, in batches.

let app: Application
let userId: string

const DAY_MS = 24 * 3600 * 1000
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS)

beforeAll(async () => {
  ;({ app } = await createTestApp())
  const user = await app
    .service('users')
    .create({ tuId: 'rt01rten', givenName: 'R', surname: 'T', email: null, authSource: 'saml' })
  userId = user.id
})

afterAll(async () => {
  await app.teardown()
})

const knex = () => app.get('knex')

beforeEach(async () => {
  await knex()('authRefreshTokens').delete()
  await knex()('authSessions').delete()
  await knex()('auditEvents').delete()
})

const auditEvent = (occurredAt: Date, action: string) =>
  knex()('auditEvents').insert({ occurredAt, action, resourceType: 'test' })

// A session whose family expired at `familyExpiresAt`, with two tokens.
const session = async (familyExpiresAt: Date) => {
  const [row] = await knex()('authSessions')
    .insert({
      userId,
      issuedAt: new Date(familyExpiresAt.getTime() - DAY_MS),
      lastUsedAt: new Date(familyExpiresAt.getTime() - DAY_MS),
      idleExpiresAt: familyExpiresAt,
      familyExpiresAt
    })
    .returning('id')
  const id = (row as { id: string }).id
  await knex()('authRefreshTokens').insert([
    { sessionId: id, tokenHash: Buffer.from(`${id}-1`), rotatedAt: familyExpiresAt },
    { sessionId: id, tokenHash: Buffer.from(`${id}-2`) }
  ])
  return id
}

describe('retention cleanup', () => {
  it('deletes audit events older than auditRetentionDays (90), keeps the rest', async () => {
    for (let i = 0; i < 5; i++) await auditEvent(daysAgo(91 + i), `old-${i}`)
    await auditEvent(daysAgo(89), 'recent')

    const result = await retentionCleanup(knex(), app.get('settings'), 2)

    expect(result.auditEvents).toBe(5)
    expect(await knex()('auditEvents').pluck('action')).toEqual(['recent'])
  })

  it('deletes sessions whose family expired more than expiredSessionRetentionDays (30) ago, with their tokens', async () => {
    const old = await Promise.all([session(daysAgo(31)), session(daysAgo(40)), session(daysAgo(365))])
    const expiredRecently = await session(daysAgo(29))
    const current = await session(new Date(Date.now() + DAY_MS))

    const result = await retentionCleanup(knex(), app.get('settings'), 2)

    expect(result.sessions).toBe(3)
    expect((await knex()('authSessions').pluck('id')).sort()).toEqual([expiredRecently, current].sort())
    expect(await knex()('authRefreshTokens').whereIn('sessionId', old).count({ n: '*' })).toEqual([{ n: '0' }])
    expect(await knex()('authRefreshTokens').whereIn('sessionId', [expiredRecently, current]).count({ n: '*' })).toEqual(
      [{ n: '4' }]
    )
  })

  it('follows the runtime settings', async () => {
    await auditEvent(daysAgo(10), 'ten days')
    await knex()('settings').where({ key: 'auditRetentionDays' }).update({ value: JSON.stringify(7) })
    try {
      expect(await retentionCleanup(knex(), app.get('settings'))).toEqual({ auditEvents: 1, sessions: 0 })
    } finally {
      await knex()('settings').where({ key: 'auditRetentionDays' }).update({ value: JSON.stringify(90) })
    }
  })

  it('does nothing when nothing is due', async () => {
    await auditEvent(new Date(), 'now')
    expect(await retentionCleanup(knex(), app.get('settings'))).toEqual({ auditEvents: 0, sessions: 0 })
  })
})
