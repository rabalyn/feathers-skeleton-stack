import type { Knex } from 'knex'
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client'
import type { CompletedRequest } from './request-log.js'

// Prometheus metrics (ADR 0022), one registry per process, served on the
// internal listener. Labels stay low-cardinality: route templates, never
// ids, users or request ids. `environment` is added by Prometheus.

export const createRegistry = (service: string): Registry => {
  const registry = new Registry()
  registry.setDefaultLabels({ service })
  collectDefaultMetrics({ register: registry })
  return registry
}

// Knex pool usage, read at scrape time, so pool pressure is visible from
// the application's side as well as PgBouncer's (ADR 0004).
export const observeKnexPool = (registry: Registry, knex: Knex) => {
  const pool = (knex.client as { pool?: { numUsed(): number; numFree(): number; numPendingAcquires(): number } }).pool
  new Gauge({
    name: 'knex_pool_connections',
    help: 'Knex pool connections by state: in use, idle, and callers waiting for one',
    labelNames: ['state'],
    registers: [registry],
    collect() {
      this.set({ state: 'used' }, pool?.numUsed() ?? 0)
      this.set({ state: 'idle' }, pool?.numFree() ?? 0)
      this.set({ state: 'waiting' }, pool?.numPendingAcquires() ?? 0)
    }
  })
}

// Request count and duration per route template; errors are the 5xx
// status codes among them.
export const requestMetrics = (registry: Registry) => {
  const requests = new Counter({
    name: 'http_requests_total',
    help: 'Completed HTTP requests and WebSocket calls',
    labelNames: ['route', 'method', 'status_code'],
    registers: [registry]
  })
  const duration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duration of HTTP requests and WebSocket calls',
    labelNames: ['route', 'method'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry]
  })
  return (request: CompletedRequest) => {
    requests.inc({ route: request.route, method: request.method, status_code: String(request.status) })
    duration.observe({ route: request.route, method: request.method }, request.durationSeconds)
  }
}

export const websocketConnections = (registry: Registry, count: () => number) => {
  new Gauge({
    name: 'websocket_connections',
    help: 'Open WebSocket connections',
    registers: [registry],
    collect() {
      this.set(count())
    }
  })
}
