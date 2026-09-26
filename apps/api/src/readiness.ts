import type { Redis } from 'ioredis'
import type { Knex } from 'knex'
import { Gauge, type Registry } from 'prom-client'

// Readiness (ADR 0022): whether the API can serve an authenticated request
// right now. That needs PostgreSQL through PgBouncer (sessions, users) and
// Valkey (rate limits fail closed, ADR 0010). The IdP and LDAP are left
// out: a university outage must not make the API look broken while
// existing sessions still work.
//
// The container healthcheck stays on liveness, so a database outage never
// restarts the API; readiness is Prometheus's, through `dependency_up`.

export const DEPENDENCIES = ['postgres', 'valkey'] as const
export type Dependency = (typeof DEPENDENCIES)[number]
export type ReadinessChecks = Record<Dependency, boolean>
export type Readiness = () => Promise<ReadinessChecks>

// Each check gets this long, so a pool with callers waiting or a hung
// connection reports "down" instead of holding the probe.
export const CHECK_TIMEOUT_MS = 1000

const within = (check: () => Promise<unknown>, timeoutMs: number): Promise<boolean> => {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  return Promise.race([check().then(() => true, () => false), timeout]).finally(() => clearTimeout(timer))
}

export const createReadiness =
  (knex: Knex, valkey: Redis, timeoutMs = CHECK_TIMEOUT_MS): Readiness =>
  async () => {
    const [postgres, valkeyUp] = await Promise.all([
      within(() => knex.raw('select 1'), timeoutMs),
      within(() => valkey.ping(), timeoutMs)
    ])
    return { postgres, valkey: valkeyUp }
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
