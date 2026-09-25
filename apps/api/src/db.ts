import { readFileSync } from 'node:fs'
import knexFactory, { type Knex } from 'knex'
import type { DatabaseConfig } from './config.js'

// One Knex instance per process. The API, worker and tests reach PostgreSQL
// through PgBouncer in transaction mode (ADR 0004); only migrate connects
// directly. Both hops verify the server certificate and host name.

const toSnake = (identifier: string) => identifier.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
const toCamel = (column: string) => column.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())

const isRow = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype

const camelRow = (row: unknown) =>
  isRow(row) ? Object.fromEntries(Object.entries(row).map(([k, v]) => [toCamel(k), v])) : row

// ADR 0005: camelCase at the API boundary, snake_case in PostgreSQL, and this
// is the only place that converts. Raw SQL keeps database names; the rows it
// returns are converted like any other.
const camelCase: Partial<Knex.Config> = {
  wrapIdentifier: (value, origImpl) => origImpl(value === '*' ? value : toSnake(value)),
  postProcessResponse: (result: unknown) => {
    if (Array.isArray(result)) return result.map(camelRow)
    if (isRow(result)) return camelRow(result)
    // Result of knex.raw with pg: { rows, fields, ... }
    if (typeof result === 'object' && result !== null && Array.isArray((result as { rows?: unknown }).rows)) {
      const raw = result as { rows: unknown[] }
      raw.rows = raw.rows.map(camelRow)
    }
    return result
  }
}

export interface KnexOptions {
  // Application instances convert identifiers; migrations and the data-tier
  // tests work in database names.
  camelCase?: boolean
  overrides?: Partial<Knex.Config>
}

export const createKnex = (config: DatabaseConfig, options: KnexOptions = {}): Knex =>
  knexFactory({
    client: 'pg',
    connection: {
      host: config.databaseHost,
      port: config.databasePort,
      database: config.databaseName,
      user: config.databaseUser,
      password: config.databasePassword,
      ssl: { ca: readFileSync(config.databaseCaFile, 'utf8'), rejectUnauthorized: true }
    },
    pool: { min: 0, max: config.databasePoolMax },
    ...(options.camelCase ? camelCase : {}),
    ...options.overrides
  })
