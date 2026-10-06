import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Application } from '../../src/app.js'
import { LOCALES } from '../../src/locales.js'
import { MAIL_KINDS } from '../../src/mail/registry.js'
import { seedMailTemplates } from '../../src/mail/templates.js'
import type { User } from '../../src/services/users/users.schema.js'
import { createTestApp } from '../support/app.js'
import { db } from '../support/worker-database.js'
import { allBut, makeUser } from '../support/roles.js'

// ADR 0027: templates seeded from code defaults, immutable revisions, the
// check on save, roll back; and ADR 0011's mail row: `mail.manage` only. The
// users hold roles of the test's own (ADR 0035).

let app: Application
let admin: User
let operator: User
let member: User
const knex = () => app.get('knex')
const as = (user: User) => ({ provider: 'rest' as const, user, authenticated: true })

const KIND = 'gdpr.export-ready'
const ID = `${KIND}:de`
// Restored after the tests, so other files send the default wording.
let defaults: Map<string, string>

beforeAll(async () => {
  ;({ app } = await createTestApp())
  admin = await makeUser(app, 'mt01admn', 'admin')
  operator = await makeUser(app, 'mt02oper', allBut('mail.manage'))
  member = await makeUser(app, 'mt03user')
  defaults = new Map((await app.service('mail-templates').find()).map((template) => [template.id, template.revisionId]))
})

afterAll(async () => {
  for (const [id, revisionId] of defaults) await app.service('mail-templates').patch(id, { revisionId })
  await app.teardown()
})

const save = (subject: string, body: string, who = admin, kind = KIND) =>
  app.service('mail-template-revisions').create({ kind, locale: 'de', subject, body }, as(who))

describe('mail templates: seeded from code', () => {
  it('has the default wording of every kind in every locale, by the system', async () => {
    const templates = await app.service('mail-templates').find()
    for (const kind of MAIL_KINDS) {
      for (const locale of LOCALES) {
        const template = templates.find((each) => each.id === `${kind.key}:${locale}`)
        expect(template).toMatchObject({ kind: kind.key, locale, declared: true })
        const first = await knex()('mailTemplateRevisions').where({ kind: kind.key, locale }).orderBy('createdAt').first()
        expect(first).toMatchObject({ ...kind.defaults[locale], authorId: null })
      }
    }
  })

  it('never overwrites what exists when seeding again', async () => {
    const before = await app.service('mail-templates').get(ID)
    await save('Geändert', 'Neu, {{ recipient.givenName }}')
    expect(await seedMailTemplates(db())).toEqual([])
    const after = await app.service('mail-templates').get(ID)
    expect(after.subject).toBe('Geändert')
    await app.service('mail-templates').patch(ID, { revisionId: before.revisionId })
  })
})

describe('mail templates: saving', () => {
  it('writes a new revision, makes it active and audits it', async () => {
    const revision = await save('Export fertig', 'Hallo {{ recipient.givenName }}, am {{ requestedAt | date }}.')
    expect(revision).toMatchObject({ kind: KIND, locale: 'de', authorId: admin.id })
    expect(await app.service('mail-templates').get(ID)).toMatchObject({ revisionId: revision.id, subject: 'Export fertig' })
    const audited = await knex()('auditEvents').where({ action: 'mail.template.save', resourceId: ID }).orderBy('occurredAt', 'desc').first()
    expect(audited).toMatchObject({ actorId: admin.id, detail: { revisionId: revision.id } })
  })

  it.each([
    ['a misspelled variable', 'Hallo', 'Hallo\n\n{{ recipient.givenNmae }}', 'body', 3],
    ['a variable of another kind', '{{ documents.size }}', 'x', 'subject', 1],
    ['a filter outside the set', 'Hallo', '{{ recipient.givenName | raw }}', 'body', 1],
    ['a link out of the application', 'Hallo', '[x](https://evil.example/)', 'body', 1],
    ['broken Liquid', 'Hallo', 'eins\n{% if ownData %}', 'body', 2]
  ])('refuses %s, naming the part and line', async (_what, subject, body, part, line) => {
    const before = await app.service('mail-templates').get(ID)
    await expect(save(subject, body)).rejects.toMatchObject({ code: 400, errors: [{ part, line }] })
    expect((await app.service('mail-templates').get(ID)).revisionId).toBe(before.revisionId)
  })

  it('refuses a kind that code does not declare', async () => {
    await expect(save('x', 'y', admin, 'nope.kind')).rejects.toMatchObject({ code: 400 })
  })

  it('keeps every revision; activating an older one rolls back, audited', async () => {
    const first = await save('Erste', 'Eins')
    await save('Zweite', 'Zwei')
    const history = await app.service('mail-template-revisions').find({ ...as(admin), query: { kind: KIND, locale: 'de' } })
    expect(history.data.slice(0, 2).map((revision) => revision.subject)).toEqual(['Zweite', 'Erste'])
    const active = await app.service('mail-templates').patch(ID, { revisionId: first.id }, as(admin))
    expect(active).toMatchObject({ revisionId: first.id, subject: 'Erste', body: 'Eins' })
    expect(await knex()('auditEvents').where({ action: 'mail.template.activate', resourceId: ID, actorId: admin.id })).toHaveLength(1)
  })

  it('activates only a revision of the same kind and locale', async () => {
    const english = await app.service('mail-templates').get(`${KIND}:en`)
    await expect(app.service('mail-templates').patch(ID, { revisionId: english.revisionId }, as(admin))).rejects.toMatchObject({ code: 400 })
  })

  it('previews unsaved wording against the sample, or says what is wrong', async () => {
    const preview = await app.service('mail-previews').create({ kind: KIND, locale: 'en', subject: 'Hi {{ recipient.givenName }}', body: '**Ready**' }, as(admin))
    expect(preview.subject).toBe('Hi Erika')
    expect(preview.html).toContain('<strong>Ready</strong>')
    await expect(
      app.service('mail-previews').create({ kind: KIND, locale: 'en', subject: 'x', body: '{{ nope }}' }, as(admin))
    ).rejects.toMatchObject({ code: 400, errors: [{ part: 'body', line: 1 }] })
  })
})

describe('mail templates: mail.manage only (ADR 0011)', () => {
  it.each([
    ['everything else', () => operator],
    ['nothing', () => member]
  ])('holding %s, neither reads nor writes mail wording', async (_role, who) => {
    await expect(app.service('mail-kinds').find(as(who()))).rejects.toMatchObject({ code: 403 })
    await expect(app.service('mail-templates').find(as(who()))).rejects.toMatchObject({ code: 403 })
    await expect(app.service('mail-template-revisions').find(as(who()))).rejects.toMatchObject({ code: 403 })
    await expect(save('x', 'y', who())).rejects.toMatchObject({ code: 403 })
    await expect(app.service('mail-templates').patch(ID, { revisionId: defaults.get(ID)! }, as(who()))).rejects.toMatchObject({ code: 403 })
    await expect(
      app.service('mail-previews').create({ kind: KIND, locale: 'de', subject: 'x', body: 'y' }, as(who()))
    ).rejects.toMatchObject({ code: 403 })
  })

  it('shows admins the kinds with their variables and sample', async () => {
    const kinds = await app.service('mail-kinds').find(as(admin))
    expect(kinds.map((kind) => kind.key).sort()).toEqual(MAIL_KINDS.map((kind) => kind.key).sort())
    const kind = await app.service('mail-kinds').get(KIND, as(admin))
    expect(kind).toMatchObject({ type: 'notification', sample: { ownData: true } })
    expect(Object.keys((kind.variables as { properties: object }).properties)).toEqual(expect.arrayContaining(['recipient', 'app', 'requestedAt']))
  })
})
