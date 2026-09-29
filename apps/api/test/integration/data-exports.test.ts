import { createHash, randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { pino } from 'pino'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { fromBufferPromise } from 'yauzl'
import type { Application } from '../../src/app.js'
import { buildExport } from '../../src/gdpr/export.js'
import { exportExpiry } from '../../src/jobs/export-expiry.js'
import { queueConnection, startMaintenance, type Maintenance } from '../../src/jobs/maintenance.js'
import type { DataExport } from '../../src/services/data-exports/data-exports.schema.js'
import type { Storage } from '../../src/storage.js'
import type { User } from '../../src/services/users/users.schema.js'
import { createTestApp, loadValkeyConfig } from '../support/app.js'
import { DATA_EXPORTS_TEST_BUCKET } from '../support/global-setup.js'
import { grantRoles, type SeededRole } from '../support/roles.js'

// ADR 0013 over HTTP against the stack's Valkey, Garage and a worker of the
// test's own: who may export whom, the job, the relayed outcome, the ZIP and
// its download, and export expiry. ADR 0011's export cells. Exports go to a
// bucket of this file's own, since the expiry's orphan sweep removes every
// object it has no row for.

let app: Application
let base: string
let maintenance: Maintenance
let admin: User
let operator: User
let member: User
let other: User
const tokens = new Map<string, string>()

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n')
const PNG = Buffer.concat([
  Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex'),
  Buffer.alloc(64, 1)
])

const knex = () => app.get('knex')

const tokenFor = async (user: User) => {
  const cached = tokens.get(user.id)
  if (cached) return cached
  const { session } = await app.get('sessions').issue(user.id)
  const token = await app.service('authentication').createAccessToken({ sid: session.id }, { subject: user.id })
  tokens.set(user.id, token)
  return token
}

const call = async (user: User, path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${await tokenFor(user)}`, 'content-type': 'application/json', ...init.headers }
  })

const requestExport = (user: User, subjectId: string) =>
  call(user, '/data-exports', { method: 'POST', body: JSON.stringify({ subjectId }) })

// Resolves with the relayed event of an export once the worker is done.
const outcome = (id: string) =>
  new Promise<DataExport>((resolve) => {
    const listener = (row: DataExport) => {
      if (row.id !== id) return
      app.service('data-exports').off('patched', listener)
      resolve(row)
    }
    app.service('data-exports').on('patched', listener)
  })

// A stored file of `owner`, with its object, as an upload leaves it.
const storedFile = async (owner: User, filename: string, body: Buffer, contentType: string) => {
  const [row] = await knex()('files')
    .insert({
      ownerId: owner.id,
      filename,
      contentType,
      sizeBytes: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
      state: 'stored',
      attachedAt: new Date()
    })
    .returning('id')
  const id = (row as { id: string }).id
  await app.get('storage').put(id, Readable.from(body), body.length, contentType)
  return id
}

const unzip = async (body: Buffer) => {
  const zip = await fromBufferPromise(body)
  const entries = new Map<string, Buffer>()
  for await (const entry of zip.eachEntry()) {
    const chunks: Buffer[] = []
    for await (const chunk of await zip.openReadStreamPromise(entry)) chunks.push(chunk as Buffer)
    entries.set(entry.fileName, Buffer.concat(chunks))
  }
  return entries
}

beforeAll(async () => {
  ;({ app } = await createTestApp({ s3: { s3ExportsBucket: DATA_EXPORTS_TEST_BUCKET } }))
  const server = await app.listen(0)
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
  maintenance = startMaintenance({
    connection: queueConnection(await loadValkeyConfig()),
    knex: knex(),
    settings: app.get('settings'),
    storage: app.get('storage'),
    exports: app.get('exports'),
    logger: pino({ level: 'silent' }),
    prefix: app.get('config').queuePrefix
  })
  const users = app.service('users')
  const make = async (tuId: string, role: SeededRole) => {
    const created = await users.create({ tuId, givenName: 'Given', surname: tuId, email: `${tuId}@example.test`, authSource: 'saml' })
    return grantRoles(app, created.id, [role])
  }
  admin = await make('ad01admn', 'admin')
  operator = await make('op01oper', 'operator')
  member = await make('us01user', 'user')
  other = await make('us02othr', 'user')
})

afterAll(async () => {
  await maintenance.exportQueue.obliterate({ force: true })
  await maintenance.queue.obliterate({ force: true })
  await maintenance.mail.queue.obliterate({ force: true })
  await maintenance.close()
  await app.teardown()
})

beforeEach(async () => {
  await knex()('dataExports').delete()
})

describe('requesting an export (ADR 0011)', () => {
  it('lets every role export itself, and refuses exporting others to all but admin', async () => {
    for (const user of [member, operator, admin]) {
      const response = await requestExport(user, user.id)
      expect(response.status, user.tuId ?? '').toBe(201)
      expect(await response.json()).toMatchObject({ subjectId: user.id, requestedBy: user.id, state: 'pending' })
    }
    expect((await requestExport(member, other.id)).status).toBe(403)
    expect((await requestExport(operator, other.id)).status).toBe(403)
    expect((await requestExport(admin, other.id)).status).toBe(201)
  })

  it('allows one pending export per person', async () => {
    await maintenance.exportWorker.pause()
    try {
      expect((await requestExport(member, member.id)).status).toBe(201)
      const second = await requestExport(member, member.id)
      expect(second.status).toBe(409)
      expect((await requestExport(admin, member.id)).status).toBe(409)
    } finally {
      await maintenance.exportWorker.resume()
    }
  })

  it('refuses an unknown or erased subject alike', async () => {
    const unknown = await requestExport(admin, randomUUID())
    const erasedUser = await app.service('users').create({ tuId: 'er01gone', givenName: 'E', surname: 'R', email: null, authSource: 'saml' })
    await knex().raw('SELECT erase_user(?)', [erasedUser.id])
    const erased = await requestExport(admin, erasedUser.id)
    expect(unknown.status).toBe(400)
    expect(erased.status).toBe(400)
    expect((await erased.json()).message).toBe((await unknown.json()).message)
  })

  it('shows an export to the account that asked for it only', async () => {
    const created = (await (await requestExport(admin, member.id)).json()) as DataExport
    const own = (await (await call(member, '/data-exports')).json()) as { data: DataExport[] }
    expect(own.data.map((row) => row.id)).not.toContain(created.id)
    expect((await call(member, `/data-exports/${created.id}`)).status).toBe(404)
    expect((await call(admin, `/data-exports/${created.id}`)).status).toBe(200)
    const outsider = (await (await call(operator, '/data-exports')).json()) as { data: DataExport[] }
    expect(outsider.data).toEqual([])
  })

  it('audits the request with its subject', async () => {
    const created = (await (await requestExport(admin, other.id)).json()) as DataExport
    const event = await knex()('auditEvents').where({ action: 'data-exports.create', resourceId: created.id }).first()
    expect(event).toMatchObject({ actorId: admin.id, resourceType: 'data-exports', detail: { subjectId: other.id } })
  })
})

describe('building and downloading an export', () => {
  it('builds a ZIP of export.json and the files, relays the outcome and serves it to the requester', async () => {
    const documentFile = await storedFile(member, 'Bericht ü/../x.pdf', PDF, 'application/pdf')
    const avatarFile = await storedFile(member, 'me.png', PNG, 'image/png')
    await knex()('users').where({ id: member.id }).update({ avatarFileId: avatarFile })
    await knex()('documents').insert({ ownerId: member.id, title: 'Report', fileId: documentFile })
    // Another person's file stays out.
    await storedFile(other, 'theirs.pdf', PDF, 'application/pdf')

    const response = await requestExport(member, member.id)
    const created = (await response.json()) as DataExport
    const done = await outcome(created.id)
    expect(done).toMatchObject({ id: created.id, state: 'ready', sizeBytes: expect.any(Number), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })

    const download = await call(member, `/data-export-contents/${created.id}`)
    expect(download.status).toBe(200)
    expect(download.headers.get('content-type')).toBe('application/zip')
    expect(download.headers.get('content-disposition')).toMatch(/^attachment; filename="data-export-\d{4}-\d{2}-\d{2}\.zip"/)
    expect(download.headers.get('x-content-type-options')).toBe('nosniff')
    const body = Buffer.from(await download.arrayBuffer())
    expect(body.length).toBe(done.sizeBytes)
    expect(createHash('sha256').update(body).digest('hex')).toBe(done.sha256)

    const entries = await unzip(body)
    const json = JSON.parse(entries.get('export.json')!.toString('utf8'))
    expect(json).toMatchObject({
      format: 'data-export/1',
      subjectId: member.id,
      account: { id: member.id, tuId: 'us01user', givenName: 'Given', surname: 'us01user', email: 'us01user@example.test', locale: 'de', avatarFileId: avatarFile },
      roles: [{ key: 'user', name: { de: 'Benutzer', en: 'User' } }],
      documents: [expect.objectContaining({ title: 'Report', fileId: documentFile })],
      sessions: expect.any(Array),
      auditEvents: expect.arrayContaining([expect.objectContaining({ action: 'data-exports.create', actorId: member.id })])
    })
    expect(json.files.map((file: { id: string }) => file.id).sort()).toEqual([documentFile, avatarFile].sort())
    // One path segment per name, whatever the name holds.
    const pdfEntry = json.files.find((file: { id: string }) => file.id === documentFile)
    expect(pdfEntry.path).toBe(`files/${documentFile}/Bericht ü_.._x.pdf`)
    expect(entries.get(pdfEntry.path)).toEqual(PDF)
    expect(entries.get(json.files.find((file: { id: string }) => file.id === avatarFile).path)).toEqual(PNG)
    expect(entries.size).toBe(3)

    const audited = await knex()('auditEvents').where({ action: 'data-exports.download', resourceId: created.id })
    expect(audited).toEqual([expect.objectContaining({ actorId: member.id })])
  })

  it('serves an export to nobody but its requester, and nothing before it is ready', async () => {
    await maintenance.exportWorker.pause()
    let created!: DataExport
    try {
      created = (await (await requestExport(admin, other.id)).json()) as DataExport
      expect((await call(admin, `/data-export-contents/${created.id}`)).status).toBe(404)
    } finally {
      await maintenance.exportWorker.resume()
    }
    await outcome(created.id)
    expect((await call(admin, `/data-export-contents/${created.id}`)).status).toBe(200)
    expect((await call(other, `/data-export-contents/${created.id}`)).status).toBe(404)
    expect((await call(operator, `/data-export-contents/${created.id}`)).status).toBe(404)
  })

  it("puts an admin's export of a person into that person's own export", async () => {
    const byAdmin = (await (await requestExport(admin, other.id)).json()) as DataExport
    await outcome(byAdmin.id)
    const own = (await (await requestExport(other, other.id)).json()) as DataExport
    await outcome(own.id)
    const body = Buffer.from(await (await call(other, `/data-export-contents/${own.id}`)).arrayBuffer())
    const json = JSON.parse((await unzip(body)).get('export.json')!.toString('utf8'))
    expect(json.auditEvents).toContainEqual(
      expect.objectContaining({ action: 'data-exports.create', actorId: admin.id, detail: { subjectId: other.id } })
    )
    expect(json.dataExports.map((row: { id: string }) => row.id)).toContain(byAdmin.id)
  })

  it('exports a file whose object is missing as missing, and reports it', async () => {
    const present = await storedFile(other, 'here.pdf', PDF, 'application/pdf')
    const [lost] = await knex()('files')
      .insert({ ownerId: other.id, filename: 'lost.pdf', contentType: 'application/pdf', sizeBytes: 10, sha256: 'b'.repeat(64), state: 'stored' })
      .returning('id')
    const lostId = (lost as { id: string }).id
    try {
      const [row] = await knex()('dataExports').insert({ subjectId: other.id, requestedBy: other.id }).returning('id')
      const exportId = (row as { id: string }).id
      const result = await buildExport({ knex: knex(), uploads: app.get('storage'), exports: app.get('exports'), exportId, mail: app.get('mail') })
      expect(result).toMatchObject({ state: 'ready', missingFiles: [lostId] })

      const stored = await app.get('exports').get(exportId)
      const chunks: Buffer[] = []
      for await (const chunk of stored!.body) chunks.push(chunk as Buffer)
      const entries = await unzip(Buffer.concat(chunks))
      const json = JSON.parse(entries.get('export.json')!.toString('utf8'))
      expect(json.files).toContainEqual(expect.objectContaining({ id: lostId, filename: 'lost.pdf', missing: true, path: null }))
      const here = json.files.find((file: { id: string }) => file.id === present)
      expect(here.missing).toBeUndefined()
      expect(entries.get(here.path)).toEqual(PDF)
      // Everything with a path, and nothing for the lost file.
      expect(entries.size).toBe(json.files.filter((file: { path: string | null }) => file.path).length + 1)
      expect([...entries.keys()].some((name) => name.includes(lostId))).toBe(false)
    } finally {
      await knex()('files').whereIn('id', [present, lostId]).delete()
    }
  })

  it('fails cleanly when an object vanishes before the upload reads anything', async () => {
    const [row] = await knex()('dataExports').insert({ subjectId: other.id, requestedBy: other.id }).returning('id')
    const [file] = await knex()('files')
      .insert({ ownerId: other.id, filename: 'gone.pdf', contentType: 'application/pdf', sizeBytes: 10, sha256: 'e'.repeat(64), state: 'stored' })
      .returning('id')
    // An exports bucket that is slow to start the upload, as Garage may be.
    const slow = {
      putStream: async (_key: string, body: AsyncIterable<Buffer>) => {
        await new Promise((resolve) => setTimeout(resolve, 200))
        for await (const chunk of body) void chunk
      },
      delete: async () => {}
    } as unknown as Storage
    // Present when checked, gone when read.
    const vanishing = { exists: async () => true, get: async () => undefined } as unknown as Storage
    try {
      await expect(
        buildExport({ knex: knex(), uploads: vanishing, exports: slow, exportId: (row as { id: string }).id, mail: app.get('mail') })
      ).rejects.toThrow(/object missing/)
    } finally {
      await knex()('files').where({ id: (file as { id: string }).id }).delete()
    }
  })

  it('marks an export failed when its last attempt fails, and relays that', async () => {
    // An object that does not match its row: the ZIP entry fails.
    const file = await storedFile(operator, 'short.pdf', PDF, 'application/pdf')
    await knex()('files').where({ id: file }).update({ sizeBytes: PDF.length + 1 })
    try {
      const [row] = await knex()('dataExports').insert({ subjectId: operator.id, requestedBy: operator.id }).returning('id')
      const exportId = (row as { id: string }).id
      const failed = outcome(exportId)
      await maintenance.exportQueue.add('build-export', { exportId }, { jobId: exportId, attempts: 1 })
      expect(await failed).toMatchObject({ id: exportId, state: 'failed' })
    } finally {
      await knex()('files').where({ id: file }).delete()
    }
  })
})

// Two people with the same kinds of data, all of it created over HTTP as the
// web app does: each export holds exactly its subject's data, and nothing of
// the other's, and neither reaches the other's exports (ADR 0011, 0013).
describe("two people's exports", () => {
  const JPEG = Buffer.concat([Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex'), Buffer.alloc(64, 2)])
  const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(32, 3)])
  // Distinct bytes per file, so a stray file shows by its content too.
  const pdf = (label: string) => Buffer.concat([PDF, Buffer.from(`%${label}\n`)])

  interface Person {
    user: User
    sessionIds: string[]
    // Everything the person uploaded, by file id.
    uploads: Map<string, Buffer>
    documentIds: string[]
    avatarId: string
    exportIds: string[]
  }

  const upload = async (user: User, body: Buffer, contentType: string, filename: string) => {
    const response = await fetch(`${base}/files`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await tokenFor(user)}`, 'content-type': contentType, 'x-file-name': encodeURIComponent(filename) },
      body: new Uint8Array(body)
    })
    expect(response.status).toBe(201)
    return ((await response.json()) as { id: string }).id
  }

  const setAvatar = async (user: User, fileId: string) =>
    expect((await call(user, '/avatars', { method: 'POST', body: JSON.stringify({ fileId }) })).status).toBe(201)

  // A person with `sessions` logins; their calls use the first.
  const person = async (tuId: string, sessions: number): Promise<Person> => {
    const created = await app.service('users').create({ tuId, givenName: tuId, surname: 'Test', email: `${tuId}@example.test`, authSource: 'saml' })
    const user = await grantRoles(app, created.id, ['user'])
    const sessionIds: string[] = []
    for (let i = 0; i < sessions; i++) {
      const { session } = await app.get('sessions').issue(user.id)
      sessionIds.push(session.id)
      if (i === 0) tokens.set(user.id, await app.service('authentication').createAccessToken({ sid: session.id }, { subject: user.id }))
    }
    return { user, sessionIds, uploads: new Map(), documentIds: [], avatarId: '', exportIds: [] }
  }

  const addDocument = async (someone: Person, title: string, body: Buffer) => {
    const fileId = await upload(someone.user, body, 'application/pdf', `${title}.pdf`)
    someone.uploads.set(fileId, body)
    const response = await call(someone.user, '/documents', { method: 'POST', body: JSON.stringify({ title, fileId }) })
    expect(response.status).toBe(201)
    someone.documentIds.push(((await response.json()) as { id: string }).id)
  }

  const addAvatar = async (someone: Person, body: Buffer, contentType: string) => {
    const fileId = await upload(someone.user, body, contentType, 'me')
    await setAvatar(someone.user, fileId)
    // A replaced avatar is released, and no longer the person's data.
    if (someone.avatarId) someone.uploads.delete(someone.avatarId)
    someone.uploads.set(fileId, body)
    someone.avatarId = fileId
  }

  const exportOf = async (requester: User, subject: Person) => {
    const created = (await (await requestExport(requester, subject.user.id)).json()) as DataExport
    expect(await outcome(created.id)).toMatchObject({ state: 'ready' })
    subject.exportIds.push(created.id)
    return created.id
  }

  const download = async (user: User, exportId: string) => {
    const response = await call(user, `/data-export-contents/${exportId}`)
    expect(response.status).toBe(200)
    const entries = await unzip(Buffer.from(await response.arrayBuffer()))
    return { entries, json: JSON.parse(entries.get('export.json')!.toString('utf8')) }
  }

  // Every identifier of a person that must not appear in anyone else's export.
  const identifiers = (someone: Person) => [
    someone.user.id,
    someone.user.tuId!,
    someone.user.email!,
    ...someone.sessionIds,
    ...someone.uploads.keys(),
    ...someone.documentIds,
    ...someone.exportIds
  ]

  const expectOnly = async (
    { entries, json }: Awaited<ReturnType<typeof download>>,
    owner: Person,
    stranger: Person,
    expectedExports: string[]
  ) => {
    expect(json.subjectId).toBe(owner.user.id)
    expect(json.account).toMatchObject({ id: owner.user.id, tuId: owner.user.tuId, avatarFileId: owner.avatarId })
    expect(json.documents.map((d: { id: string }) => d.id).sort()).toEqual([...owner.documentIds].sort())
    expect(json.sessions.map((s: { id: string }) => s.id).sort()).toEqual([...owner.sessionIds].sort())
    expect(json.dataExports.map((e: { id: string }) => e.id).sort()).toEqual([...expectedExports].sort())
    // Their files, bytes and all, and nothing else in the ZIP.
    expect(json.files.map((f: { id: string }) => f.id).sort()).toEqual([...owner.uploads.keys()].sort())
    for (const file of json.files as { id: string; path: string }[]) expect(entries.get(file.path)).toEqual(owner.uploads.get(file.id))
    expect([...entries.keys()].sort()).toEqual(['export.json', ...json.files.map((f: { path: string }) => f.path)].sort())
    // Every audit event concerns the owner.
    for (const event of json.auditEvents as { actorId: string; resourceType: string; resourceId: string; detail: { subjectId?: string } | null }[]) {
      expect(
        event.actorId === owner.user.id ||
          (event.resourceType === 'users' && event.resourceId === owner.user.id) ||
          event.detail?.subjectId === owner.user.id,
        JSON.stringify(event)
      ).toBe(true)
    }
    // Nothing of the other person, anywhere.
    const text = entries.get('export.json')!.toString('utf8')
    for (const id of identifiers(stranger)) expect(text, id).not.toContain(id)
    for (const bytes of stranger.uploads.values()) expect([...entries.values()].some((entry) => entry.includes(bytes))).toBe(false)
  }

  it('each holds exactly its own documents, avatar, sessions and exports, and only its requester gets it', async () => {
    const alice = await person('us05alic', 3)
    const bob = await person('us06bobb', 2)
    await addDocument(alice, 'alice-1', pdf('alice-1'))
    await addDocument(alice, 'alice-2', pdf('alice-2'))
    await addDocument(bob, 'bob-1', pdf('bob-1'))
    await addAvatar(alice, PNG, 'image/png')
    await addAvatar(alice, WEBP, 'image/webp')
    await addAvatar(bob, JPEG, 'image/jpeg')

    const aliceFirst = await exportOf(alice.user, alice)
    const aliceSecond = await exportOf(alice.user, alice)
    const byAdmin = await exportOf(admin, bob)
    const bobOwn = await exportOf(bob.user, bob)

    // An export lists every export of its subject, itself included.
    await expectOnly(await download(alice.user, aliceFirst), alice, bob, [aliceFirst])
    await expectOnly(await download(alice.user, aliceSecond), alice, bob, [aliceFirst, aliceSecond])
    await expectOnly(await download(bob.user, bobOwn), bob, alice, [byAdmin, bobOwn])
    await expectOnly(await download(admin, byAdmin), bob, alice, [byAdmin])

    // Each lists and fetches the exports they asked for, and nothing else,
    // however the query is put.
    const listed = async (user: User, query = '') =>
      ((await (await call(user, `/data-exports${query}`)).json()) as { data: DataExport[] }).data.map((row) => row.id).sort()
    expect(await listed(alice.user)).toEqual([aliceFirst, aliceSecond].sort())
    expect(await listed(bob.user)).toEqual([bobOwn])
    for (const query of [`?subjectId=${bob.user.id}`, `?$or[0][requestedBy]=${admin.id}`, `?requestedBy[$ne]=${alice.user.id}`]) {
      expect(await listed(alice.user, query), query).toEqual([])
    }
    for (const [user, exportId] of [
      [alice.user, bobOwn],
      [alice.user, byAdmin],
      [bob.user, aliceFirst],
      [bob.user, byAdmin],
      [operator, aliceFirst],
      [operator, bobOwn],
      [admin, bobOwn]
    ] as const) {
      expect((await call(user, `/data-exports/${exportId}`)).status, `${user.tuId} ${exportId}`).toBe(404)
      expect((await call(user, `/data-export-contents/${exportId}`)).status, `${user.tuId} ${exportId}`).toBe(404)
    }

    // Neither reaches the other's documents, files or avatar.
    for (const [user, stranger] of [
      [alice.user, bob],
      [bob.user, alice]
    ] as const) {
      const documents = ((await (await call(user, '/documents')).json()) as { data: { ownerId: string }[] }).data
      expect(documents.length).toBeGreaterThan(0)
      expect(documents.every((d) => d.ownerId === user.id)).toBe(true)
      for (const id of stranger.documentIds) expect((await call(user, `/documents/${id}`)).status).toBe(404)
      for (const id of stranger.uploads.keys()) {
        expect((await call(user, `/files/${id}`)).status).toBe(404)
        expect((await call(user, `/file-contents/${id}`)).status).toBe(404)
      }
      expect((await call(user, `/users/${stranger.user.id}`)).status).toBe(404)
    }
  })
})

describe('export expiry', () => {
  const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000)

  it('removes exports past exportRetentionDays with their object, fails stalled ones and removes orphans', async () => {
    const exports = app.get('exports')
    const put = (key: string) => exports.put(key, Readable.from(Buffer.from('zip')), 3, 'application/zip')
    const insert = async (values: Record<string, unknown>) => {
      const [row] = await knex()('dataExports')
        .insert({ subjectId: member.id, requestedBy: member.id, ...values })
        .returning('id')
      return (row as { id: string }).id
    }
    const ready = { state: 'ready', sizeBytes: 3, sha256: 'd'.repeat(64), completedAt: new Date() }
    const old = await insert({ ...ready, createdAt: daysAgo(8) })
    const recent = await insert({ ...ready, createdAt: daysAgo(6) })
    await insert({ state: 'failed', createdAt: daysAgo(9) })
    const stalled = await insert({ createdAt: new Date(Date.now() - 25 * 3600_000) })
    await Promise.all([put(old), put(recent)])
    const orphan = randomUUID()
    await put(orphan)

    // A fresh orphan is within the hour's grace; none here. The earlier
    // tests' exports lost their rows to beforeEach, so they are orphans too.
    const before = await knex()('dataExports').pluck('id')
    let objects = 0
    for await (const page of exports.list()) objects += page.filter((object) => !before.includes(object.key)).length
    const result = await exportExpiry(knex(), app.get('settings'), exports, { orphanGraceHours: 0 })

    expect(result).toEqual({ expired: 2, stalled: 1, orphans: objects })
    expect(objects).toBeGreaterThanOrEqual(1)
    expect((await knex()('dataExports').pluck('id')).sort()).toEqual([recent, stalled].sort())
    expect(await knex()('dataExports').where({ id: stalled }).first()).toMatchObject({ state: 'failed' })
    expect(await exports.get(old)).toBeUndefined()
    expect(await exports.get(orphan)).toBeUndefined()
    expect(await exports.get(recent)).toBeDefined()
  })
})
