import { createServer, type Server } from 'node:http'

// Internal listener (ADR 0006, 0022): reachable only on the observability
// network, outside the Feathers pipeline, never routed by Nginx.
//
// Only liveness exists for now. What readiness checks is listed as undecided
// in docs/adr_v2/README.md, and /metrics arrives with the observability slice.
export const createInternalServer = (): Server =>
  createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health/live') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"status":"ok"}')
      return
    }
    res.writeHead(404)
    res.end()
  })
