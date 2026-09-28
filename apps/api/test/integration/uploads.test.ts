import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Application } from '../../src/app.js'
import type { Document } from '../../src/services/documents/documents.schema.js'
import type { File } from '../../src/services/files/files.schema.js'
import type { User } from '../../src/services/users/users.schema.js'
import { createTestApp } from '../support/app.js'
import { db } from '../support/worker-database.js'

// ADR 0020 and the documents and avatar cells of ADR 0011's matrix, over
// HTTP against the stack's Garage.

let app: Application
let base: string
let admin: User
let operator: User
let member: User
let other: User
const tokens = new Map<string, string>()

// Smallest bodies file-type recognises as each format.
const PNG = Buffer.concat([
  Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex'),
  Buffer.alloc(64, 1)
])
const JPEG = Buffer.concat([Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex'), Buffer.alloc(64, 2)])
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n')
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(32, 3)])
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')

const setSetting = (key: string, value: unknown) => db()('settings').where({ key }).update({ value: JSON.stringify(value) })

const tokenFor = async (user: User) => {
  const cached = tokens.get(user.id)
  if (cached) return cached
  const { session } = await app.get('sessions').issue(user.id)
  const token = await app.service('authentication').createAccessToken({ sid: session.id, role: user.role }, { subject: user.id })
  tokens.set(user.id, token)
  return token
}

const upload = async (user: User | undefined, body: Buffer, type: string, filename = 'file name ü.bin', init: RequestInit = {}) =>
  fetch(`${base}/files`, {
    method: 'POST',
    headers: {
      ...(user ? { authorization: `Bearer ${await tokenFor(user)}` } : {}),
      'content-type': type,
      'x-file-name': encodeURIComponent(filename)
    },
    body: new Uint8Array(body),
    ...init
  })

const uploaded = async (user: User, body: Buffer, type: string, filename?: string) => {
  const response = await upload(user, body, type, filename)
  expect(response.status).toBe(201)
  return (await response.json()) as File
}

const download = async (user: User, fileId: string) =>
  fetch(`${base}/file-contents/${fileId}`, { headers: { authorization: `Bearer ${await tokenFor(user)}` } })

const as = (user: User) => ({ provider: 'rest' as const, user, authenticated: true })

beforeAll(async () => {
  ;({ app } = await createTestApp())
  const server = await app.listen(0)
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
  const users = app.service('users')
  const make = async (tuId: string, role: User['role']) => {
    const created = await users.create({ tuId, givenName: tuId, surname: 'Test', email: `${tuId}@example.org`, authSource: 'saml' })
    return role === 'user' ? created : users.patch(created.id, { role })
  }
  admin = await make('ad02admn', 'admin')
  operator = await make('op02oper', 'operator')
  member = await make('us03user', 'user')
  other = await make('us04othr', 'user')
})

afterEach(async () => {
  await setSetting('maxUploadBytes', 8 * 1024 * 1024)
  await setSetting('userQuotaBytes', 100 * 1000 * 1000)
  await setSetting('totalQuotaBytes', 5 * 1000 * 1000 * 1000)
})

afterAll(async () => {
  await app.teardown()
})

describe('files: upload', () => {
  it('stores each allowed format, with its verified type, size and checksum', async () => {
    for (const [body, type] of [
      [PDF, 'application/pdf'],
      [PNG, 'image/png'],
      [JPEG, 'image/jpeg'],
      [WEBP, 'image/webp']
    ] as const) {
      const file = await uploaded(member, body, type)
      expect(file).toMatchObject({
        ownerId: member.id,
        filename: 'file name ü.bin',
        contentType: type,
        sizeBytes: body.length,
        sha256: createHash('sha256').update(body).digest('hex')
      })
      // Bookkeeping stays internal.
      expect(file).not.toHaveProperty('state')
      expect(file).not.toHaveProperty('deletedAt')
      const stored = await app.get('storage').get(file.id)
      const chunks: Buffer[] = []
      for await (const chunk of stored!.body as AsyncIterable<Buffer>) chunks.push(chunk)
      const bytes = Buffer.concat(chunks)
      expect(bytes.equals(body)).toBe(true)
    }
  })

  it('refuses a type outside the allowlist, SVG included, before reading it', async () => {
    expect((await upload(member, SVG, 'image/svg+xml')).status).toBe(415)
    expect((await upload(member, PDF, 'text/plain')).status).toBe(415)
  })

  it('refuses content whose magic bytes do not match the declared type', async () => {
    const response = await upload(member, PDF, 'image/png')
    expect(response.status).toBe(415)
    expect(await db()('files').where({ owner_id: member.id, content_type: 'image/png', size_bytes: PDF.length }).first()).toBeUndefined()
  })

  it('refuses an SVG declared as an allowed image', async () => {
    expect((await upload(member, SVG, 'image/png')).status).toBe(415)
  })

  it('needs a length: chunked bodies are refused', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(PNG)
        controller.close()
      }
    })
    const response = await fetch(`${base}/files`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await tokenFor(member)}`, 'content-type': 'image/png', 'x-file-name': 'a.png' },
      body: stream,
      duplex: 'half'
    } as RequestInit)
    expect(response.status).toBe(411)
  })

  it('refuses a file above the maximum size before storing anything', async () => {
    await setSetting('maxUploadBytes', PNG.length - 1)
    const response = await upload(member, PNG, 'image/png')
    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({ data: { reason: 'size' } })
  })

  it('refuses an upload beyond the user quota, counting only their live files', async () => {
    const quotaUser = await app.service('users').create({ tuId: 'us05quot', authSource: 'saml', givenName: 'q', surname: 'q', email: null })
    const first = await uploaded(quotaUser, PNG, 'image/png')
    await setSetting('userQuotaBytes', PNG.length * 2 - 1)
    const response = await upload(quotaUser, PNG, 'image/png')
    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({ data: { reason: 'user-quota' } })
    // A soft-deleted file no longer counts against its owner.
    await db()('files').where({ id: first.id }).update({ deleted_at: new Date() })
    expect((await upload(quotaUser, PNG, 'image/png')).status).toBe(201)
  })

  it('refuses an upload beyond the total quota, which soft-deleted files still count against', async () => {
    const usage = await db()('files').sum({ total: 'size_bytes' }).first<{ total: string }>()
    await setSetting('totalQuotaBytes', Number(usage.total) + PNG.length - 1)
    const response = await upload(member, PNG, 'image/png')
    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({ data: { reason: 'total-quota' } })
  })

  it('refuses a filename with a path separator', async () => {
    expect((await upload(member, PNG, 'image/png', '../etc/passwd')).status).toBe(400)
  })

  it('refuses anonymous uploads', async () => {
    expect((await upload(undefined, PNG, 'image/png')).status).toBe(401)
  })

  it('cannot upload over a WebSocket-style call without a body', async () => {
    await expect(app.service('files').create({ filename: 'x.png' }, as(member))).rejects.toMatchObject({ code: 400 })
  })
})

describe('files: reading', () => {
  it('lets the owner, operators and admins read a file; others get a 404', async () => {
    const file = await uploaded(member, PDF, 'application/pdf')
    await expect(app.service('files').get(file.id, as(member))).resolves.toMatchObject({ id: file.id })
    await expect(app.service('files').get(file.id, as(operator))).resolves.toMatchObject({ id: file.id })
    await expect(app.service('files').get(file.id, as(admin))).resolves.toMatchObject({ id: file.id })
    await expect(app.service('files').get(file.id, as(other))).rejects.toMatchObject({ code: 404 })
    expect((await download(other, file.id)).status).toBe(404)
  })

  it('serves a document as an attachment, with nosniff and its verified type', async () => {
    const file = await uploaded(member, PDF, 'application/pdf', 'Bericht "Q3" ä.pdf')
    const response = await download(member, file.id)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/pdf')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="Bericht _Q3_ _.pdf"; filename*=UTF-8''${encodeURIComponent('Bericht "Q3" ä.pdf')}`
    )
    expect(Buffer.from(await response.arrayBuffer()).equals(PDF)).toBe(true)
  })

  it('does not serve a soft-deleted file', async () => {
    const file = await uploaded(member, PDF, 'application/pdf')
    await db()('files').where({ id: file.id }).update({ deleted_at: new Date() })
    expect((await download(member, file.id)).status).toBe(404)
    await expect(app.service('files').get(file.id, as(member))).rejects.toMatchObject({ code: 404 })
  })
})

describe('documents', () => {
  const createDocument = async (user: User, title = 'Doc') => {
    const file = await uploaded(user, PDF, 'application/pdf')
    return app.service('documents').create({ title, fileId: file.id }, as(user))
  }

  it('creates a document owned by the caller, with the file attached', async () => {
    const document = await createDocument(member)
    expect(document).toMatchObject({ ownerId: member.id, title: 'Doc', file: { contentType: 'application/pdf', sizeBytes: PDF.length } })
    expect(await db()('files').where({ id: document.fileId }).first()).toMatchObject({ attached_at: expect.any(Date) })
  })

  it('refuses a file that is not the caller’s, or already attached, or does not exist', async () => {
    const othersFile = await uploaded(other, PDF, 'application/pdf')
    await expect(app.service('documents').create({ title: 'x', fileId: othersFile.id }, as(member))).rejects.toMatchObject({ code: 400 })
    const document = await createDocument(member)
    await expect(app.service('documents').create({ title: 'x', fileId: document.fileId }, as(member))).rejects.toMatchObject({ code: 400 })
    await expect(
      app.service('documents').create({ title: 'x', fileId: '01a0d950-4ccc-71d2-bc85-40a1a963e526' }, as(member))
    ).rejects.toMatchObject({ code: 400 })
  })

  it('lets a user see, change and remove only their own documents', async () => {
    const own = await createDocument(member, 'mine')
    const theirs = await createDocument(other, 'theirs')
    const { data } = (await app.service('documents').find(as(member))) as { data: Document[] }
    expect(data.map((d) => d.ownerId)).toEqual(expect.arrayContaining([member.id]))
    expect(data.every((d) => d.ownerId === member.id)).toBe(true)
    await expect(app.service('documents').get(theirs.id, as(member))).rejects.toMatchObject({ code: 404 })
    await expect(app.service('documents').patch(theirs.id, { title: 'x' }, as(member))).rejects.toMatchObject({ code: 404 })
    await expect(app.service('documents').remove(theirs.id, as(member))).rejects.toMatchObject({ code: 404 })
    await expect(app.service('documents').patch(own.id, { title: 'renamed' }, as(member))).resolves.toMatchObject({ title: 'renamed' })
  })

  it('lets operators and admins read, change and remove any document', async () => {
    const document = await createDocument(member)
    for (const user of [operator, admin]) {
      await expect(app.service('documents').get(document.id, as(user))).resolves.toMatchObject({ id: document.id })
      await expect(app.service('documents').patch(document.id, { title: user.role }, as(user))).resolves.toMatchObject({ title: user.role })
    }
    await app.service('documents').remove(document.id, as(operator))
  })

  it('releases the file on removal and on replacement, by soft deletion', async () => {
    const document = await createDocument(member)
    const replacement = await uploaded(member, PDF, 'application/pdf')
    await app.service('documents').patch(document.id, { fileId: replacement.id }, as(member))
    expect(await db()('files').where({ id: document.fileId }).first()).toMatchObject({ deleted_at: expect.any(Date) })
    await app.service('documents').remove(document.id, as(member))
    expect(await db()('files').where({ id: replacement.id }).first()).toMatchObject({ deleted_at: expect.any(Date) })
    // The object stays until the purge job, past backup retention.
    expect(await app.get('storage').get(replacement.id)).toBeDefined()
  })
})

describe('avatars', () => {
  it('lets every role set the avatar of their own record, served inline', async () => {
    for (const user of [member, operator, admin]) {
      const file = await uploaded(user, PNG, 'image/png', 'me.png')
      await expect(app.service('avatars').create({ fileId: file.id }, as(user))).resolves.toMatchObject({ id: user.id, avatarFileId: file.id })
      const response = await download(user, file.id)
      expect(response.headers.get('content-disposition')).toMatch(/^inline; /)
      expect(response.headers.get('content-type')).toBe('image/png')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    }
  })

  it('accepts only raster images as avatars', async () => {
    const pdf = await uploaded(member, PDF, 'application/pdf')
    await expect(app.service('avatars').create({ fileId: pdf.id }, as(member))).rejects.toMatchObject({ code: 400 })
  })

  it('sets only the caller’s own avatar: others’ files cannot be attached, and users.patch does not take it', async () => {
    const othersFile = await uploaded(other, PNG, 'image/png')
    await expect(app.service('avatars').create({ fileId: othersFile.id }, as(member))).rejects.toMatchObject({ code: 400 })
    const own = await uploaded(admin, PNG, 'image/png')
    // Not even an admin sets someone else's avatar through users.
    await expect(app.service('users').patch(member.id, { avatarFileId: own.id } as never, as(admin))).rejects.toMatchObject({ code: 400 })
  })

  it('shows avatars to operators and admins, not to other users', async () => {
    const file = await uploaded(other, JPEG, 'image/jpeg')
    await app.service('avatars').create({ fileId: file.id }, as(other))
    expect((await download(operator, file.id)).status).toBe(200)
    expect((await download(admin, file.id)).status).toBe(200)
    expect((await download(member, file.id)).status).toBe(404)
  })

  it('releases the previous avatar when replaced or cleared', async () => {
    const first = await uploaded(other, PNG, 'image/png')
    await app.service('avatars').create({ fileId: first.id }, as(other))
    const second = await uploaded(other, WEBP, 'image/webp')
    await app.service('avatars').create({ fileId: second.id }, as(other))
    expect(await db()('files').where({ id: first.id }).first()).toMatchObject({ deleted_at: expect.any(Date) })
    await app.service('avatars').create({ fileId: null }, as(other))
    expect(await db()('files').where({ id: second.id }).first()).toMatchObject({ deleted_at: expect.any(Date) })
  })
})
