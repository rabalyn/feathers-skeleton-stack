import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Application } from '../../src/app.js'
import type { User } from '../../src/services/users/users.schema.js'
import { API_SETTINGS, SETTINGS, SETTING_KEYS } from '../../src/settings/registry.js'
import { SettingsStore, seedSettings } from '../../src/settings/store.js'
import { BODY_SIZE_CEILING_BYTES, createTestApp } from '../support/app.js'
import { db } from '../support/worker-database.js'

// ADR 0025 (runtime settings) and the settings row of ADR 0011's matrix.

let app: Application
let admin: User
let operator: User
let member: User

const as = (user: User) => ({ provider: 'rest' as const, user, authenticated: true })

beforeAll(async () => {
  ;({ app } = await createTestApp())
  const users = app.service('users')
  const make = async (tuId: string, role: User['role']) => {
    const created = await users.create({ tuId, givenName: tuId, surname: 'T', email: `${tuId}@example.org`, authSource: 'saml' })
    return role === 'user' ? created : users.patch(created.id, { role })
  }
  admin = await make('ad01admn', 'admin')
  operator = await make('op01oper', 'operator')
  member = await make('us01user', 'user')
})

afterAll(async () => {
  await app.teardown()
})

describe('seeding', () => {
  it('the template carries every registered key with its default', async () => {
    const rows = await db()('settings').select('key', 'value', 'updated_by')
    expect(rows.map((r) => r.key).sort()).toEqual([...SETTING_KEYS].sort())
    for (const row of rows) {
      expect(row.value).toEqual(SETTINGS[row.key as keyof typeof SETTINGS].default)
      expect(row.updated_by).toBeNull()
    }
  })

  it('inserts missing keys and never overwrites an existing value', async () => {
    await db()('settings').where({ key: 'auditRetentionDays' }).update({ value: JSON.stringify(365) })
    await db()('settings').where({ key: 'exportRetentionDays' }).delete()
    expect(await seedSettings(db())).toEqual(['exportRetentionDays'])
    const rows = Object.fromEntries((await db()('settings').select('key', 'value')).map((r) => [r.key, r.value]))
    expect(rows.auditRetentionDays).toBe(365)
    expect(rows.exportRetentionDays).toBe(7)
    await db()('settings').where({ key: 'auditRetentionDays' }).update({ value: JSON.stringify(90) })
  })
})

describe('refusing to start', () => {
  it('passes with every key the API needs', async () => {
    await expect(new SettingsStore(db()).assertPresent(API_SETTINGS)).resolves.toBeUndefined()
  })

  it('names a missing and an invalid key', async () => {
    await db()('settings').where({ key: 'maintenanceMode' }).delete()
    await db()('settings').where({ key: 'sessionIdleSeconds' }).update({ value: JSON.stringify('eight hours') })
    const error = await new SettingsStore(db()).assertPresent(API_SETTINGS).catch((e: Error) => e)
    expect(String(error)).toMatch(/maintenanceMode is missing/)
    expect(String(error)).toMatch(/sessionIdleSeconds is invalid/)
    await seedSettings(db())
    await db()('settings').where({ key: 'sessionIdleSeconds' }).update({ value: JSON.stringify(8 * 3600) })
  })
})

describe('settings: read for admin and operator, write for admin only', () => {
  it.each([
    ['admin', () => admin],
    ['operator', () => operator]
  ])('%s lists and reads settings', async (_role, who) => {
    const page = await app.service('settings').find(as(who()))
    expect(page.total).toBe(SETTING_KEYS.length)
    await expect(app.service('settings').get('sessionIdleSeconds', as(who()))).resolves.toMatchObject({
      key: 'sessionIdleSeconds',
      value: 8 * 3600
    })
  })

  // With no rule on the resource at all, CASL refuses before any lookup, so
  // an existing and a missing key are answered alike (ADR 0011).
  it('user can neither list nor read settings, and learns nothing about which keys exist', async () => {
    await expect(app.service('settings').find(as(member))).rejects.toMatchObject({ code: 403 })
    const existing = await app.service('settings').get('sessionIdleSeconds', as(member)).catch((e) => e)
    const missing = await app.service('settings').get('noSuchKey', as(member)).catch((e) => e)
    expect(existing).toMatchObject({ code: 403 })
    expect({ code: missing.code, message: missing.message }).toEqual({
      code: existing.code,
      message: existing.message
    })
  })

  it.each([
    ['operator', () => operator],
    ['user', () => member]
  ])('%s cannot change a setting', async (_role, who) => {
    await expect(
      app.service('settings').patch('refreshGraceSeconds', { value: 20 }, as(who()))
    ).rejects.toMatchObject({ code: 403 })
  })

  it('rejects unauthenticated calls, and create and remove over the transports', async () => {
    await expect(app.service('settings').find({ provider: 'rest' })).rejects.toMatchObject({ code: 401 })
    const server = await app.listen(0)
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/settings`
    expect((await fetch(base, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status).toBe(405)
    expect((await fetch(`${base}/maintenanceMode`, { method: 'DELETE' })).status).toBe(405)
  })
})

describe('writing a setting', () => {
  it('admin changes a value, recorded with who, when, and an audit event', async () => {
    const patched = await app.service('settings').patch('refreshGraceSeconds', { value: 20 }, as(admin))
    expect(patched).toMatchObject({ key: 'refreshGraceSeconds', value: 20, updatedBy: admin.id })
    const [event] = await db()('audit_events').where({ action: 'settings.update', resource_id: 'refreshGraceSeconds' })
    expect(event).toMatchObject({ actor_id: admin.id, resource_type: 'settings', detail: { from: 10, to: 20 } })
    await app.service('settings').patch('refreshGraceSeconds', { value: 10 }, as(admin))
  })

  it('the in-process cache sees the change at once', async () => {
    const store = app.get('settings')
    expect(await store.get('maintenanceMode')).toBe(false)
    await app.service('settings').patch('maintenanceMode', { value: true }, as(admin))
    expect(await store.get('maintenanceMode')).toBe(true)
    await app.service('settings').patch('maintenanceMode', { value: false }, as(admin))
  })

  it.each([
    ['sessionIdleSeconds', 'eight hours'],
    ['sessionIdleSeconds', 0],
    ['sessionIdleSeconds', 1.5],
    ['maintenanceMode', 'yes'],
    ['featureFlags', { 'not a name': true }],
    ['featureFlags', { newThing: 'on' }],
    ['backupSchedule', 'daily']
  ])('rejects %s = %j against its schema', async (key, value) => {
    await expect(app.service('settings').patch(key, { value }, as(admin))).rejects.toMatchObject({ code: 400 })
  })

  it('rejects a missing value or extra fields', async () => {
    await expect(app.service('settings').patch('maintenanceMode', {} as never, as(admin))).rejects.toMatchObject({ code: 400 })
    await expect(
      app.service('settings').patch('maintenanceMode', { value: true, updatedBy: admin.id } as never, as(admin))
    ).rejects.toMatchObject({ code: 400 })
  })

  it('rejects an unknown key and multi patch', async () => {
    await expect(app.service('settings').patch('nope', { value: 1 }, as(admin))).rejects.toMatchObject({ code: 404 })
    await expect(app.service('settings').patch(null, { value: 1 }, as(admin))).rejects.toMatchObject({ code: 405 })
  })
})

describe('cross-setting rules', () => {
  it('the object purge delay must exceed the backup retention', async () => {
    await expect(
      app.service('settings').patch('objectPurgeDelayDays', { value: 31 }, as(admin))
    ).rejects.toMatchObject({ code: 400 })
    await expect(
      app.service('settings').patch('backupRetentionDailySnapshots', { value: 32 }, as(admin))
    ).rejects.toMatchObject({ code: 400 })
    await expect(
      app.service('settings').patch('objectPurgeDelayDays', { value: 40 }, as(admin))
    ).resolves.toMatchObject({ value: 40 })
    await app.service('settings').patch('objectPurgeDelayDays', { value: 32 }, as(admin))
  })

  it('the maximum upload size must stay below the Nginx ceiling', async () => {
    await expect(
      app.service('settings').patch('maxUploadBytes', { value: BODY_SIZE_CEILING_BYTES }, as(admin))
    ).rejects.toMatchObject({ code: 400 })
    await expect(
      app.service('settings').patch('maxUploadBytes', { value: BODY_SIZE_CEILING_BYTES - 1 }, as(admin))
    ).resolves.toMatchObject({ value: BODY_SIZE_CEILING_BYTES - 1 })
    await app.service('settings').patch('maxUploadBytes', { value: SETTINGS.maxUploadBytes.default }, as(admin))
  })

  it('the idle timeout must not exceed the absolute lifetime', async () => {
    await expect(
      app.service('settings').patch('sessionIdleSeconds', { value: 8 * 24 * 3600 }, as(admin))
    ).rejects.toMatchObject({ code: 400 })
  })

  it('a rejected write changes nothing and is not audited', async () => {
    const before = await db()('audit_events').where({ resource_id: 'maxUploadBytes' }).count({ n: '*' })
    await app.service('settings').patch('maxUploadBytes', { value: 1e12 }, as(admin)).catch(() => undefined)
    const after = await db()('audit_events').where({ resource_id: 'maxUploadBytes' }).count({ n: '*' })
    expect(after).toEqual(before)
    const [row] = await db()('settings').where({ key: 'maxUploadBytes' })
    expect(row.value).toBe(SETTINGS.maxUploadBytes.default)
  })
})

describe('audit of administrative user changes', () => {
  it('records a role change by an admin, with the changed fields only', async () => {
    await app.service('users').patch(member.id, { role: 'operator' }, as(admin))
    await app.service('users').patch(member.id, { role: 'user' }, as(admin))
    const events = await db()('audit_events').where({ action: 'users.patch', resource_id: member.id }).orderBy('occurred_at')
    expect(events.map((e) => e.detail)).toEqual([{ role: 'operator' }, { role: 'user' }])
    expect(events[0]).toMatchObject({ actor_id: admin.id, resource_type: 'users' })
  })
})
