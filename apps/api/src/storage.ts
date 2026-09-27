import { readFileSync } from 'node:fs'
import { Agent } from 'node:https'
import type { Readable } from 'node:stream'
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  UploadPartCommand
} from '@aws-sdk/client-s3'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import type { S3Config } from './config.js'

// Object storage (ADR 0020): Garage over TLS verified against the CA root,
// with this service's own key, on one bucket: the uploads bucket of this
// deployment (`uploads`) unless another is named, such as the exports bucket
// (ADR 0013). Locally the tests and the e2e api have buckets of their own.
// Object keys are server-generated UUIDs, the id of the `files` row that
// describes the object; nothing a user supplies is part of a key. Objects
// are written once and never modified.

// The buckets production has; emptying one is refused (empty-bucket.ts).
export const PRODUCTION_BUCKETS = ['uploads', 'exports'] as const

// S3 requires at least 5 MiB for every part but the last.
export const MULTIPART_PART_BYTES = 8 * 1024 * 1024

export interface StoredObject {
  body: Readable
  length: number
}

export interface ListedObject {
  key: string
  lastModified: Date
  size: number
}

export class Storage {
  readonly client: S3Client
  readonly bucket: string

  constructor(config: S3Config, bucket: string = config.s3UploadsBucket) {
    this.bucket = bucket
    this.client = new S3Client({
      endpoint: config.s3Endpoint,
      region: 'garage',
      // Garage serves buckets as paths; no bucket host names exist.
      forcePathStyle: true,
      credentials: { accessKeyId: config.s3KeyId, secretAccessKey: config.s3SecretKey },
      // The body is streamed with its length known, so no checksum trailer
      // and no chunked signing are needed.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      requestHandler: new NodeHttpHandler({
        httpsAgent: new Agent({ ca: readFileSync(config.s3CaFile, 'utf8'), keepAlive: true }),
        connectionTimeout: 2000,
        requestTimeout: 60_000
      })
    })
  }

  async put(key: string, body: Readable, length: number, contentType: string, abortSignal?: AbortSignal): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentLength: length, ContentType: contentType }),
      { abortSignal }
    )
  }

  // A body of unknown length, such as a zip being written, as a multipart
  // upload: held in memory one part at a time. An upload that fails is
  // aborted, so no parts are left behind.
  async putStream(key: string, body: AsyncIterable<Buffer>, contentType: string): Promise<void> {
    const { UploadId } = await this.client.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: contentType })
    )
    const parts: { ETag: string; PartNumber: number }[] = []
    const upload = async (chunks: Buffer[]) => {
      const PartNumber = parts.length + 1
      const Body = Buffer.concat(chunks)
      const { ETag } = await this.client.send(
        new UploadPartCommand({ Bucket: this.bucket, Key: key, UploadId, PartNumber, Body, ContentLength: Body.length })
      )
      parts.push({ ETag: ETag!, PartNumber })
    }
    try {
      let chunks: Buffer[] = []
      let size = 0
      for await (const chunk of body) {
        chunks.push(chunk)
        size += chunk.length
        if (size >= MULTIPART_PART_BYTES) {
          await upload(chunks)
          chunks = []
          size = 0
        }
      }
      // The last part may be small, or empty for an empty body.
      if (size > 0 || parts.length === 0) await upload(chunks)
      await this.client.send(
        new CompleteMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId, MultipartUpload: { Parts: parts } })
      )
    } catch (error) {
      await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId })).catch(() => {})
      throw error
    }
  }

  // Undefined when the object does not exist.
  async get(key: string): Promise<StoredObject | undefined> {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
      return { body: result.Body as Readable, length: result.ContentLength ?? 0 }
    } catch (error) {
      if (error instanceof NoSuchKey) return undefined
      throw error
    }
  }

  // Idempotent: deleting a missing object succeeds.
  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
  }

  // Every object, a page at a time.
  async *list(): AsyncGenerator<ListedObject[]> {
    let token: string | undefined
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, ContinuationToken: token, MaxKeys: 1000 })
      )
      yield (page.Contents ?? []).map((object) => ({ key: object.Key!, lastModified: object.LastModified!, size: object.Size ?? 0 }))
      token = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (token)
  }

  async deleteMany(keys: string[]): Promise<void> {
    if (!keys.length) return
    await this.client.send(
      new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } })
    )
  }

  // Removes every object; for the buckets of test runs only (empty-bucket.ts).
  async empty(): Promise<number> {
    let removed = 0
    for await (const page of this.list()) {
      await this.deleteMany(page.map((object) => object.key))
      removed += page.length
    }
    return removed
  }

  // Readiness (ADR 0022): the bucket answers to this service's key.
  async ping(abortSignal?: AbortSignal): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }), { abortSignal })
  }

  close() {
    this.client.destroy()
  }
}
