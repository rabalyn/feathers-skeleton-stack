import { readFileSync } from 'node:fs'
import knexFactory, { type Knex } from 'knex'
import type { DatabaseConfig } from './config.js'

// One Knex instance per process. The API, worker and tests reach PostgreSQL
// through PgBouncer in transaction mode (ADR 0004); only migrate connects
// directly. Both hops verify the server certificate and host name.
export const createKnex = (config: DatabaseConfig, overrides: Partial<Knex.Config> = {}): Knex =>
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
    ...overrides
  })
