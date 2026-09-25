import { createServer, type Server } from 'node:http'

// Internal listener (ADR 0006, 0022): reachable only on the observability
// network, outside the Feathers pipeline, never routed by Nginx.
//
// Only liveness exists for now. What readiness checks is listed as undecided
// in docs/adr_v2/README.md, and /metrics arrives with the observability slice.
// `live` lets a process say it is alive beyond answering at all: the worker
// is live while its BullMQ worker runs.
export const createInternalServer = (live: () => boolean = () => true): Server =>
  createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health/live') {
      const ok = live()
      res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' })
      res.end(ok ? '{"status":"ok"}' : '{"status":"down"}')
      return
    }
    res.writeHead(404)
    res.end()
  })
