import { readFileSync } from 'node:fs'
import { Redis } from 'ioredis'
import type { ValkeyConfig } from './config.js'

// One Valkey connection per process (ADR 0010): rate-limit state now, BullMQ
// queues later. TLS with full verification like the database hops (ADR 0004).
//
// Commands are never queued while disconnected and time out quickly, so an
// unreachable Valkey surfaces as an error at once, which the rate limiter
// turns into a refusal (fail closed), instead of a request that hangs.
export const createValkey = (config: ValkeyConfig): Redis =>
  new Redis({
    host: config.valkeyHost,
    port: config.valkeyPort,
    password: config.valkeyPassword,
    tls: { ca: readFileSync(config.valkeyCaFile, 'utf8'), servername: config.valkeyHost },
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    commandTimeout: 1000,
    connectTimeout: 2000,
    // Reconnect in the background, backing off to 5 s.
    retryStrategy: (attempt) => Math.min(attempt * 200, 5000)
  })
