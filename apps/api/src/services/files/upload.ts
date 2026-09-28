import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { Transform, type TransformCallback } from 'node:stream'
import { BadRequest, FeathersError, LengthRequired } from '@feathersjs/errors'
import { fileTypeFromBuffer } from 'file-type'
import type { Knex } from 'knex'
import type { SettingsStore } from '../../settings/store.js'
import type { Storage } from '../../storage.js'
import { ALLOWED_CONTENT_TYPES, type AllowedContentType } from './files.schema.js'

// Receiving an upload (ADR 0020). The body is the file itself, streamed
// from the request to Garage and never held whole in memory. In order:
//
//   1. the declared type must be on the allowlist, and the length declared
//      and within the maximum;
//   2. the first bytes are read and checked against the declared type
//      (magic bytes): a mismatch is a rejection, not a correction;
//   3. quotas are checked, and a `pending` row reserves the space, before a
//      single byte is stored;
//   4. the rest streams through to the bucket while it is hashed and
//      counted; a body shorter or longer than declared aborts the put;
//   5. the row becomes `stored`. On any failure the row and whatever
//      reached the bucket are removed.

export class PayloadTooLarge extends FeathersError {
  constructor(message: string, data?: unknown) {
    super(message, 'PayloadTooLarge', 413, 'payload-too-large', data)
  }
}

export class UnsupportedMediaType extends FeathersError {
  constructor(message: string) {
    super(message, 'UnsupportedMediaType', 415, 'unsupported-media-type', undefined)
  }
}

// What the files service's Koa middleware hands over from the request.
export interface Upload {
  stream: IncomingMessage
  contentType: string | undefined
  contentLength: number | undefined
}

// Enough for every signature file-type checks for the allowed formats.
const SNIFF_BYTES = 4100

// Serialises quota reservations; held only while a row is inserted.
const QUOTA_LOCK = 'files:quota'

export const declaredType = (header: string | undefined): AllowedContentType | undefined => {
  const type = header?.split(';')[0]?.trim().toLowerCase()
  return ALLOWED_CONTENT_TYPES.find((allowed) => allowed === type)
}

// Reads the first `bytes` of the body (fewer if it ends first), leaving the
// stream paused with the rest unread.
const readHead = (stream: IncomingMessage, bytes: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let length = 0
    const done = (error?: Error) => {
      stream.off('data', onData).off('end', onEnd).off('error', done).off('aborted', onAborted)
      stream.pause()
      if (error) reject(error)
      else resolve(Buffer.concat(chunks))
    }
    const onData = (chunk: Buffer) => {
      chunks.push(chunk)
      length += chunk.length
      if (length >= bytes) done()
    }
    const onEnd = () => done()
    const onAborted = () => done(new BadRequest('The upload was aborted'))
    stream.on('data', onData).once('end', onEnd).once('error', done).once('aborted', onAborted)
  })

// Passes everything through while hashing and counting it; fails when the
// body turns out longer or shorter than declared.
class Counter extends Transform {
  private received = 0
  private readonly hash = createHash('sha256')

  constructor(private readonly expectedLength: number) {
    super()
  }

  get sha256() {
    return this.hash.digest('hex')
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    this.received += chunk.length
    if (this.received > this.expectedLength) {
      callback(new BadRequest('The body is longer than its Content-Length'))
      return
    }
    this.hash.update(chunk)
    callback(null, chunk)
  }

  override _flush(callback: TransformCallback) {
    callback(this.received === this.expectedLength ? null : new BadRequest('The body is shorter than its Content-Length'))
  }
}

export interface ReceiveOptions {
  knex: Knex
  settings: SettingsStore
  storage: Storage
  ownerId: string
  filename: string
  upload: Upload
}

export interface ReceivedFile {
  id: string
}

export const receive = async ({ knex, settings, storage, ownerId, filename, upload }: ReceiveOptions): Promise<ReceivedFile> => {
  const contentType = declaredType(upload.contentType)
  if (!contentType) {
    throw new UnsupportedMediaType(`Allowed types: ${ALLOWED_CONTENT_TYPES.join(', ')}`)
  }
  const length = upload.contentLength
  if (length === undefined || !Number.isSafeInteger(length)) {
    throw new LengthRequired('Content-Length is required')
  }
  if (length < 1) throw new BadRequest('The file is empty')

  const [maxUploadBytes, userQuotaBytes, totalQuotaBytes] = await Promise.all([
    settings.get('maxUploadBytes'),
    settings.get('userQuotaBytes'),
    settings.get('totalQuotaBytes')
  ])
  if (length > maxUploadBytes) {
    throw new PayloadTooLarge(`The maximum file size is ${maxUploadBytes} bytes`, { reason: 'size' })
  }

  const head = await readHead(upload.stream, Math.min(SNIFF_BYTES, length))
  if ((await fileTypeFromBuffer(head))?.mime !== contentType) {
    throw new UnsupportedMediaType(`The content is not ${contentType}`)
  }

  // Soft-deleted files count against the total until purged, not against
  // their owner (ADR 0020).
  const id = await knex.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [QUOTA_LOCK])
    const usage = await trx('files')
      .select(
        trx.raw('coalesce(sum(size_bytes) FILTER (WHERE owner_id = ? AND deleted_at IS NULL), 0)::bigint AS own', [ownerId]),
        trx.raw('coalesce(sum(size_bytes), 0)::bigint AS total')
      )
      .first<{ own: string; total: string }>()
    if (Number(usage.own) + length > userQuotaBytes) {
      throw new PayloadTooLarge('Your storage quota would be exceeded', { reason: 'user-quota' })
    }
    if (Number(usage.total) + length > totalQuotaBytes) {
      throw new PayloadTooLarge('The storage quota of this system would be exceeded', { reason: 'total-quota' })
    }
    const [row] = await trx('files')
      .insert({ ownerId, filename, contentType, sizeBytes: length })
      .returning<{ id: string }[]>('id')
    return row!.id
  })

  const counter = new Counter(length)
  const abort = new AbortController()
  // Whatever breaks the body (a wrong length, a client gone mid-upload)
  // stops the put; the counter's error is the one reported.
  counter.on('error', () => abort.abort())
  upload.stream.once('aborted', () => counter.destroy(new BadRequest('The upload was aborted')))
  counter.write(head)
  // A small body may have ended while its head was read.
  if (upload.stream.readableEnded) counter.end()
  else upload.stream.pipe(counter)
  try {
    await storage.put(id, counter, length, contentType, abort.signal)
    await knex('files').where({ id }).update({ state: 'stored', sha256: counter.sha256 })
    return { id }
  } catch (error) {
    upload.stream.unpipe(counter)
    upload.stream.resume()
    await storage.delete(id).catch(() => undefined)
    await knex('files').where({ id }).delete()
    throw counter.errored ?? error
  }
}
