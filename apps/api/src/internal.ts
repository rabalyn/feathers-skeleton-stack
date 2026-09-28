import { createServer as createHttpServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFileSync } from 'node:fs'
import type { Registry } from 'prom-client'
import type { Readiness } from './readiness.js'

// Internal listener (ADR 0006, 0022): reachable only on the observability
// network, outside the Feathers pipeline, never routed by Nginx. TLS like
// every observability hop, with a certificate for the service's own name
// and `localhost`, which the container healthcheck uses.
//
// Liveness and metrics for both; readiness for the API, which checks the
// dependencies it needs to serve requests (readiness.ts).

export interface InternalServerOptions {
  metrics: Registry
  // Whether the process is alive beyond answering at all: the worker is
  // live while its BullMQ worker runs.
  live?: () => boolean
  // Only the API has one; without it /health/ready is not found.
  ready?: Readiness
  tls?: { certFile: string; keyFile: string }
}

export const createInternalServer = ({ metrics, live = () => true, ready, tls }: InternalServerOptions): Server => {
  const handle = (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && req.url === '/health/live') {
      const ok = live()
      res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' })
      res.end(ok ? '{"status":"ok"}' : '{"status":"down"}')
      return
    }
    if (ready && req.method === 'GET' && req.url === '/health/ready') {
      ready()
        .then((checks) => {
          const ok = Object.values(checks).every(Boolean)
          const status = Object.fromEntries(Object.entries(checks).map(([name, up]) => [name, up ? 'ok' : 'down']))
          res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ status: ok ? 'ok' : 'down', checks: status }))
        })
        .catch(() => {
          res.writeHead(503)
          res.end()
        })
      return
    }
    if (req.method === 'GET' && req.url === '/metrics') {
      metrics
        .metrics()
        .then((body) => {
          res.writeHead(200, { 'content-type': metrics.contentType })
          res.end(body)
        })
        .catch(() => {
          res.writeHead(500)
          res.end()
        })
      return
    }
    res.writeHead(404)
    res.end()
  }
  return tls
    ? createHttpsServer({ cert: readFileSync(tls.certFile), key: readFileSync(tls.keyFile) }, handle)
    : createHttpServer(handle)
}
