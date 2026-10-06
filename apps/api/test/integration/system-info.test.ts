import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Application } from '../../src/app.js'
import { sameRelease, type SystemInfoReport } from '../../src/services/system-info/system-info.js'
import type { User } from '../../src/services/users/users.schema.js'
import { COMPONENTS, INVENTORY } from '../../src/system/components.js'
import { COMPONENT_UPDATES_TABLE } from '../../src/system/update-check.js'
import { createTestApp } from '../support/app.js'
import { allBut, makeUser } from '../support/roles.js'

// ADR 0032: the system-info report, for `system-info.read` only: per
// component the declared version, the running one from the stack's
// Prometheus, Valkey, NetBox and the process, and the update check's
// stored results. A failing source leaves its rows without a running
// version, saying so, and the rest stands.

let app: Application
let admin: User
let member: User

const as = (user: User) => ({ provider: 'rest' as const, user, authenticated: true })

beforeAll(async () => {
  ;({ app } = await createTestApp())
  admin = await makeUser(app, 'ad01admn', 'admin')
  member = await makeUser(app, 'us01user', allBut('system-info.read'))
})

afterAll(async () => {
  await app.teardown()
})

beforeEach(async () => {
  await app.get('knex')(COMPONENT_UPDATES_TABLE).delete()
})

const component = (report: SystemInfoReport, id: string) => report.components.find((each) => each.id === id)!

describe('system-info', () => {
  it('lists every component with what is pinned and what runs', async () => {
    const report = await app.service('system-info').find(as(admin))
    expect(report.components.map((each) => each.id)).toEqual(COMPONENTS.map((each) => each.id))
    const postgres = INVENTORY.find((entry) => entry.id === 'postgresql')!
    expect(component(report, 'postgresql')).toMatchObject({ declared: postgres.version, runningMissing: null, drift: false })
    expect(component(report, 'postgresql').running).toMatch(/^\d+\.\d+/)
    for (const id of ['pgbouncer', 'valkey', 'netbox', 'garage', 'grafana', 'node']) {
      expect(component(report, id).running, id).toMatch(/^v?\d+\.\d+/)
    }
    // Nothing reports OpenBao's version.
    expect(component(report, 'openbao')).toMatchObject({ running: null, runningMissing: 'not-reported' })
    // The tests run with the check off; nothing has been checked.
    expect(report).toMatchObject({ updateCheck: 'off', checkRunning: false, attemptedAt: null })
    expect(report.app.publicOrigin).toBe(app.get('config').publicOrigin)
  })

  it('includes the update check’s results', async () => {
    const checkedAt = new Date('2026-10-01T03:30:00Z')
    await app.get('knex')(COMPONENT_UPDATES_TABLE).insert({
      component: 'postgresql',
      compared: '18.6-alpine',
      latestPatch: '18.7-alpine',
      patchSince: checkedAt,
      eolLine: '18',
      eol: '2030-11-14',
      checkedAt,
      attemptedAt: checkedAt
    })
    const report = await app.service('system-info').find(as(admin))
    expect(component(report, 'postgresql')).toMatchObject({
      latestPatch: '18.7-alpine',
      patchSince: checkedAt.toISOString(),
      eolLine: '18',
      eol: '2030-11-14',
      checkedAt: checkedAt.toISOString(),
      error: null
    })
    expect(report.attemptedAt).toBe(checkedAt.toISOString())
  })

  it('says which running versions are missing when Prometheus cannot be reached', async () => {
    const { app: offline } = await createTestApp({ system: { prometheusUrl: 'https://127.0.0.1:1' } })
    try {
      const report = await offline.service('system-info').find(as(admin))
      expect(component(report, 'postgresql')).toMatchObject({ running: null, runningMissing: 'source-failed' })
      // The other sources still answer.
      expect(component(report, 'valkey').running).toMatch(/^\d+\.\d+/)
    } finally {
      await offline.teardown()
    }
  })

  it('refuses whoever lacks system-info.read (ADR 0011)', async () => {
    await expect(app.service('system-info').find(as(member))).rejects.toMatchObject({ code: 403 })
  })
})

describe('sameRelease', () => {
  it('compares the release, not the spelling', () => {
    expect(sameRelease('18.6-alpine', '18.6.0')).toBe(true)
    expect(sameRelease('24.21.0-trixie-slim', '24.21.0')).toBe(true)
    expect(sameRelease('v2.4.1', '2.4.1')).toBe(true)
    expect(sameRelease('18.6-alpine', '18.5')).toBe(false)
    expect(sameRelease('26.10.0-trixie-slim', '24.21.0')).toBe(false)
  })
})
