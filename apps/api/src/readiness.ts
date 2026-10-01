import type { Redis } from 'ioredis'
import type { Knex } from 'knex'
import { Gauge, type Registry } from '@prometheus-io/client'
import type { Storage } from './storage.js'

// Readiness (ADR 0022): whether the API can serve its requests right now.
// That needs PostgreSQL through PgBouncer (sessions, users), Valkey (rate
// limits fail closed, ADR 0010) and the object store (uploads and
// downloads, ADR 0020). The IdP and LDAP are left out: a university outage
// must not make the API look broken while existing sessions still work.
//
// The container healthcheck stays on liveness, so a database outage never
// restarts the API; readiness is Prometheus's, through `dependency_up`.

export const DEPENDENCIES = ['postgres', 'valkey', 's3'] as const
export type Dependency = (typeof DEPENDENCIES)[number]
export type ReadinessChecks = Record<Dependency, boolean>
export type Readiness = () => Promise<ReadinessChecks>

// Each check gets this long, so a pool with callers waiting or a hung
// connection reports "down" instead of holding the probe.
export const CHECK_TIMEOUT_MS = 1000

// A check that can be cancelled is, once its time is up.
const within = (check: (signal: AbortSignal) => Promise<unknown>, timeoutMs: number): Promise<boolean> => {
  const abort = new AbortController()
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      abort.abort()
      resolve(false)
    }, timeoutMs)
  })
  return Promise.race([check(abort.signal).then(() => true, () => false), timeout]).finally(() => clearTimeout(timer))
}

export const createReadiness =
  (knex: Knex, valkey: Redis, storage: Storage, timeoutMs = CHECK_TIMEOUT_MS): Readiness =>
  async () => {
    const [postgres, valkeyUp, s3] = await Promise.all([
      within(() => knex.raw('select 1'), timeoutMs),
      within(() => valkey.ping(), timeoutMs),
      within((signal) => storage.ping(signal), timeoutMs)
    ])
    return { postgres, valkey: valkeyUp, s3 }
  }

// The same checks, run at scrape time, so the alert and the dashboard see
// what /health/ready answers.
export const observeReadiness = (registry: Registry, readiness: Readiness) => {
  new Gauge({
    name: 'dependency_up',
    help: 'Whether a dependency the API needs to serve requests answers: 1 up, 0 down',
    labelNames: ['dependency'],
    registers: [registry],
    async collect() {
      const checks = await readiness()
      for (const dependency of DEPENDENCIES) this.set({ dependency }, checks[dependency] ? 1 : 0)
    }
  })
}
