import { readFileSync } from 'node:fs'
import { Agent } from 'node:https'
import type { Readable } from 'node:stream'
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import type { S3Config } from './config.js'

// Object storage (ADR 0020): Garage over TLS verified against the CA root,
// with this service's own key, on the uploads bucket of this deployment
// (`uploads`; locally the tests and the e2e api have buckets of their own).
// Object keys are server-generated UUIDs, the id of the `files` row that
// describes the object; nothing a user supplies is part of a key. Objects
// are written once and never modified.

// The buckets production has; emptying one is refused (empty-bucket.ts).
export const PRODUCTION_BUCKETS = ['uploads', 'exports'] as const

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

  constructor(config: S3Config) {
    this.bucket = config.s3UploadsBucket
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
