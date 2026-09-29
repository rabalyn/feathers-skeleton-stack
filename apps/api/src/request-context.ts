import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'

// What a log line, an audit event or an enqueued job knows about the request
// it happens in (ADR 0021): one store per HTTP request or WebSocket call.

export interface RequestContext {
  requestId: string
  // The surrogate user key once the call is authenticated, never the TU-ID
  // (ADR 0009).
  userRef?: string
  // Whom the user views the application as (ADR 0028).
  viewAsRef?: string
}

const storage = new AsyncLocalStorage<RequestContext>()

// A W3C traceparent trace-id: 32 lowercase hex digits, not all zero. Nginx's
// $request_id has this shape, so an id arriving from the proxy is kept and
// tracing can adopt it later (ADR 0022).
const REQUEST_ID = /^(?!0{32})[0-9a-f]{32}$/

export const isRequestId = (value: unknown): value is string => typeof value === 'string' && REQUEST_ID.test(value)

export const newRequestId = (): string => randomBytes(16).toString('hex')

export const runWithRequest = <T>(context: RequestContext, fn: () => T): T => storage.run(context, fn)

export const currentRequest = (): RequestContext | undefined => storage.getStore()
