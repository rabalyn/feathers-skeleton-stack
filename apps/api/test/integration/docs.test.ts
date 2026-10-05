import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Application } from '../../src/app.js'
import type { User } from '../../src/services/users/users.schema.js'
import { createTestApp } from '../support/app.js'
import { makeUser } from '../support/roles.js'

// The ADRs and diagrams in the app (ADR 0019): read-only, under `docs.read`,
// which only the admin role holds (ADR 0011).

let app: Application
let admin: User
let operator: User
let member: User

const as = (user: User) => ({ provider: 'rest' as const, user, authenticated: true })

beforeAll(async () => {
  ;({ app } = await createTestApp())
  admin = await makeUser(app, 'ad01admn', 'admin')
  operator = await makeUser(app, 'op01oper', 'operator')
  member = await makeUser(app, 'us01user', 'user')
})

afterAll(async () => {
  await app.teardown()
})

describe('docs', () => {
  it('lists the index, every ADR and every diagram page, without their Markdown', async () => {
    const docs = await app.service('docs').find(as(admin))
    expect(docs[0]).toMatchObject({ id: 'readme', kind: 'index', path: 'README.md' })
    expect(docs).toContainEqual(
      expect.objectContaining({ id: '0001-one-stack-every-environment', kind: 'adr', number: '0001', status: 'Accepted' })
    )
    expect(docs).toContainEqual(expect.objectContaining({ id: 'diagrams-topology', kind: 'diagram', path: 'diagrams/topology.md' }))
    // The diagram pages as their index lists them, under its names.
    const diagrams = docs.filter((doc) => doc.kind === 'diagram')
    expect(diagrams.slice(0, 3).map((doc) => doc.id)).toEqual(['diagrams-readme', 'diagrams-topology', 'diagrams-startup-and-secrets'])
    expect(diagrams[2]).toMatchObject({ label: 'Startup and secrets', title: 'Startup order and secret delivery' })
    expect(docs.every((doc) => !('markdown' in doc))).toBe(true)
  })

  it('finds the pages that hold every word, in any case', async () => {
    const docs = await app.service('docs').find({ ...as(admin), query: { q: 'pgbouncer TRANSACTION', kind: 'adr' } })
    // The page with the words in its title first.
    expect(docs[0]).toMatchObject({ id: '0004-pgbouncer-pools' })
    expect(docs.every((doc) => doc.kind === 'adr' && /pgbouncer|transaction/i.test(doc.excerpt ?? ''))).toBe(true)
    // The excerpt is text, not Markdown link targets.
    expect(docs.some((doc) => doc.excerpt?.includes(']('))).toBe(false)
    await expect(app.service('docs').find({ ...as(admin), query: { q: 'no-such-word-anywhere' } })).resolves.toEqual([])
  })

  it('serves a page with its Markdown', async () => {
    const doc = await app.service('docs').get('diagrams-topology', as(admin))
    expect(doc.markdown).toContain('```mermaid')
    await expect(app.service('docs').get('../../package', as(admin))).rejects.toMatchObject({ code: 404 })
  })

  it('refuses everybody without docs.read (ADR 0011)', async () => {
    for (const user of [operator, member]) {
      await expect(app.service('docs').find(as(user))).rejects.toMatchObject({ code: 403 })
      await expect(app.service('docs').get('readme', as(user))).rejects.toMatchObject({ code: 403 })
    }
  })

  it('rejects query fields the schema does not declare (ADR 0005)', async () => {
    await expect(app.service('docs').find({ ...as(admin), query: { path: '/etc' } as never })).rejects.toMatchObject({ code: 400 })
  })
})
