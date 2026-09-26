import { readFileSync } from 'node:fs'
import { Agent } from 'node:https'
import type { Readable } from 'node:stream'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import type { S3Config } from './config.js'

// Object storage (ADR 0020): Garage over TLS verified against the CA root,
// with this service's own key. Object keys are server-generated UUIDs, the
// id of the `files` row that describes the object; nothing a user supplies
// is part of a key. Objects are written once and never modified.

export const UPLOADS_BUCKET = 'uploads'

export interface StoredObject {
  body: Readable
  length: number
}

export class Storage {
  readonly client: S3Client

  constructor(config: S3Config) {
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

  async put(
    bucket: string,
    key: string,
    body: Readable,
    length: number,
    contentType: string,
    abortSignal?: AbortSignal
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentLength: length, ContentType: contentType }),
      { abortSignal }
    )
  }

  // Undefined when the object does not exist.
  async get(bucket: string, key: string): Promise<StoredObject | undefined> {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
      return { body: result.Body as Readable, length: result.ContentLength ?? 0 }
    } catch (error) {
      if (error instanceof NoSuchKey) return undefined
      throw error
    }
  }

  // Idempotent: deleting a missing object succeeds.
  async delete(bucket: string, key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
  }

  close() {
    this.client.destroy()
  }
}
