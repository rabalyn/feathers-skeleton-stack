import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Application } from '../../src/app.js'
import type { User } from '../../src/services/users/users.schema.js'
import { createTestApp } from '../support/app.js'
import { allBut, makeUser } from '../support/roles.js'

// Locations (ADR 0031) against the stack's NetBox, seeded by netbox-setup
// from containers/netbox/seed/tu-darmstadt, through the api's read-only
// token. S1|01 is the University Centre at Karolinenplatz 5. The member
// holds sites.read through a role of the test's own (ADR 0035).

let app: Application
let unreachable: Application
let member: User

const as = (user: User) => ({ provider: 'rest' as const, user, authenticated: true })
const find = (query: Record<string, unknown>, who: User = member, on: Application = app) =>
  on.service('sites').find({ ...as(who), query })

beforeAll(async () => {
  ;({ app } = await createTestApp())
  // Nothing listens there.
  ;({ app: unreachable } = await createTestApp({ netbox: { netboxUrl: 'https://localhost:1' } }))
  member = await makeUser(app, 'us01user', ['sites.read'])
})

afterAll(async () => {
  await Promise.all([app.teardown(), unreachable.teardown()])
})

describe('sites: the address lookup', () => {
  it('finds a building by its street, with its address split and its NetBox link', async () => {
    const page = await find({ q: 'Karolinenplatz 5' })
    const karo5 = page.data.find((site) => site.key === 'S1|01')
    expect(karo5).toMatchObject({
      key: 'S1|01',
      status: 'active',
      street: 'Karolinenplatz 5',
      postalCode: '64289',
      city: 'Darmstadt',
      group: { key: 'S1' }
    })
    expect(karo5?.name).not.toContain('S1|01')
    expect(karo5?.nameEn).toMatch(/University Centre/)
    expect(karo5?.occupants.en.length).toBeGreaterThan(0)
    expect(karo5?.netboxUrl).toBe(`${app.get('config').netboxPublicUrl}/dcim/sites/${karo5?.id}/`)
  })

  it('pages through every building', async () => {
    const first = await find({ $limit: 10 })
    expect(first).toMatchObject({ limit: 10, skip: 0 })
    expect(first.data).toHaveLength(10)
    expect(first.total).toBeGreaterThan(100)
    const second = await find({ $limit: 10, $skip: 10 })
    expect(second.data.map((site) => site.id)).not.toEqual(first.data.map((site) => site.id))
  })

  it('gets a building by the NetBox id a record stores', async () => {
    const [site] = (await find({ q: 'Karolinenplatz 5' })).data
    await expect(app.service('sites').get(site!.id, as(member))).resolves.toEqual(site)
  })

  it('answers 404 for an id NetBox does not have', async () => {
    await expect(app.service('sites').get(99999999, as(member))).rejects.toMatchObject({ code: 404 })
    await expect(app.service('sites').get('not-a-number', as(member))).rejects.toMatchObject({ code: 404 })
  })

  it('answers 503 when NetBox cannot be reached', async () => {
    const other = await makeUser(unreachable, 'us02othr', ['sites.read'])
    await expect(find({ q: 'Karolinenplatz' }, other, unreachable)).rejects.toMatchObject({ code: 503 })
  })

  it('rejects unknown query fields and over-long pages (ADR 0005)', async () => {
    await expect(find({ q: 'x', name: 'x' })).rejects.toMatchObject({ code: 400 })
    await expect(find({ $limit: 51 })).rejects.toMatchObject({ code: 400 })
  })

  it('is read under sites.read only, and only read (ADR 0011)', async () => {
    await expect(app.service('sites').find({ provider: 'rest', query: {} })).rejects.toMatchObject({ code: 401 })
    const without = await makeUser(app, 'no01role', allBut('sites.read'))
    await expect(find({}, without)).rejects.toMatchObject({ code: 403 })
    const server = await app.listen(0)
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/sites`
    expect((await fetch(base, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status).toBe(405)
    expect((await fetch(`${base}/1`, { method: 'PATCH', body: '{}', headers: { 'content-type': 'application/json' } })).status).toBe(405)
  })
})
