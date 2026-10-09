import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Application } from '../../src/app.js'
import type { Site } from '../../src/services/sites/sites.schema.js'
import type { User } from '../../src/services/users/users.schema.js'
import { createTestApp } from '../support/app.js'
import { allBut, makeUser } from '../support/roles.js'

// Rooms inside sites (ADR 0031), against the stack's NetBox through the
// api's token. NetBox keeps what is added here across runs, so every room
// the test adds has a fixed name: adding it again returns it.

let app: Application
let unreachable: Application
let reader: User
let maker: User
let karo5: Site

const as = (user: User) => ({ provider: 'rest' as const, user, authenticated: true })

beforeAll(async () => {
  ;({ app } = await createTestApp())
  ;({ app: unreachable } = await createTestApp({ netbox: { netboxUrl: 'https://localhost:1' } }))
  // Each holds the one permission; what it requires comes with it (ADR 0037).
  reader = await makeUser(app, 'us01user', ['locations.read'])
  maker = await makeUser(app, 'op01oper', ['locations.create'])
  const found = (await app.service('sites').find({ ...as(reader), query: { q: 'Karolinenplatz 5' } })).data
  karo5 = found.find((site) => site.key === 'S1|01')!
})

afterAll(async () => {
  await Promise.all([app.teardown(), unreachable.teardown()])
})

describe('sites by id', () => {
  it('returns the sites of the ids a list of records stores, in one call', async () => {
    const some = (await app.service('sites').find({ ...as(reader), query: { $limit: 3 } })).data
    const ids = some.map((site) => site.id)
    const page = await app.service('sites').find({ ...as(reader), query: { id: { $in: ids } } })
    expect(page.data.map((site) => site.id).sort()).toEqual([...ids].sort())
  })

  it('takes no more ids than a page', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => i + 1)
    await expect(app.service('sites').find({ ...as(reader), query: { id: { $in: ids } } })).rejects.toMatchObject({ code: 400 })
  })
})

describe('locations: rooms in a site', () => {
  it('adds a room by name, and returns the same one when asked again, regardless of case', async () => {
    const room = await app.service('locations').create({ siteId: karo5.id, name: 'Testraum 0031' }, as(maker))
    expect(room).toMatchObject({ siteId: karo5.id, name: 'Testraum 0031', status: 'active', parent: null })
    expect(room.netboxUrl).toBe(`${app.get('config').netboxPublicUrl}/dcim/locations/${room.id}/`)
    await expect(app.service('locations').create({ siteId: karo5.id, name: ' testraum 0031 ' }, as(maker))).resolves.toEqual(room)
  })

  it('gives two people asking at once the same room', async () => {
    const [a, b] = await Promise.all([
      app.service('locations').create({ siteId: karo5.id, name: 'Testraum 0031 gleichzeitig' }, as(maker)),
      app.service('locations').create({ siteId: karo5.id, name: 'Testraum 0031 gleichzeitig' }, as(maker))
    ])
    expect(a.id).toBe(b.id)
  })

  it('adds rooms whose names make the same slug as different rooms', async () => {
    const dotted = await app.service('locations').create({ siteId: karo5.id, name: 'Testraum 1.01' }, as(maker))
    const spaced = await app.service('locations').create({ siteId: karo5.id, name: 'Testraum 1 01' }, as(maker))
    expect(spaced.id).not.toBe(dotted.id)
    expect(spaced.name).toBe('Testraum 1 01')
  })

  it("lists a site's rooms with a search, and resolves rooms by id", async () => {
    const room = await app.service('locations').create({ siteId: karo5.id, name: 'Testraum 0031' }, as(maker))
    const page = await app.service('locations').find({ ...as(reader), query: { siteId: karo5.id, q: 'Testraum 0031' } })
    expect(page.data.map((location) => location.id)).toContain(room.id)
    expect(page.data.every((location) => location.siteId === karo5.id)).toBe(true)
    const byId = await app.service('locations').find({ ...as(reader), query: { id: { $in: [room.id] } } })
    expect(byId.data).toEqual([room])
    await expect(app.service('locations').get(room.id, as(reader))).resolves.toEqual(room)
  })

  it('answers 404 for a site or a room NetBox does not have', async () => {
    await expect(app.service('locations').get(99999999, as(reader))).rejects.toMatchObject({ code: 404 })
    await expect(app.service('locations').create({ siteId: 99999999, name: 'Nirgends' }, as(maker))).rejects.toMatchObject({
      code: 404
    })
  })

  it('answers 503 when NetBox cannot be reached', async () => {
    const other = await makeUser(unreachable, 'us02othr', ['locations.read'])
    await expect(unreachable.service('locations').find({ ...as(other), query: { siteId: 1 } })).rejects.toMatchObject({ code: 503 })
  })

  it('rejects unknown fields, blank names and over-long pages (ADR 0005)', async () => {
    await expect(app.service('locations').create({ siteId: karo5.id, name: '   ' }, as(maker))).rejects.toMatchObject({ code: 400 })
    await expect(
      app.service('locations').create({ siteId: karo5.id, name: 'x', parent: 1 } as never, as(maker))
    ).rejects.toMatchObject({ code: 400 })
    await expect(app.service('locations').find({ ...as(reader), query: { $limit: 51 } })).rejects.toMatchObject({ code: 400 })
    await expect(app.service('locations').find({ ...as(reader), query: { site: 1 } as never })).rejects.toMatchObject({ code: 400 })
  })

  it('includes what a permission requires, and says on the own record what brought it (ADR 0037)', async () => {
    const own = await app.service('users').get(maker.id, as(maker))
    expect(own.permissions).toEqual(['locations.create', 'locations.read', 'sites.read'])
    expect(own.includedPermissions).toEqual({ 'locations.read': ['locations.create'], 'sites.read': ['locations.create'] })
    await expect(app.service('locations').find({ ...as(maker), query: { siteId: karo5.id } })).resolves.toMatchObject({ total: expect.any(Number) })
    // Not on anybody else's record.
    expect((await app.service('users').get(maker.id, { ...as(reader) }).catch(() => null))?.includedPermissions).toBeUndefined()
  })

  it('reads under locations.read, adds under locations.create only (ADR 0011)', async () => {
    await expect(app.service('locations').find({ provider: 'rest', query: {} })).rejects.toMatchObject({ code: 401 })
    const without = await makeUser(app, 'no01role', allBut('locations.read', 'locations.create'))
    await expect(app.service('locations').find({ ...as(without), query: { siteId: karo5.id } })).rejects.toMatchObject({ code: 403 })
    await expect(app.service('locations').create({ siteId: karo5.id, name: 'Testraum 0031' }, as(reader))).rejects.toMatchObject({
      code: 403
    })
  })
})
