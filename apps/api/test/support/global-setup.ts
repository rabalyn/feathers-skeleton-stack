import { WORKER_PREFIX, assertDatabaseName, maintenanceKnex } from './database.js'

// A crashed run must not leak state into the next one (ADR 0015).
export default async function setup() {
  const knex = await maintenanceKnex()
  try {
    const { rows } = await knex.raw<{ rows: { datname: string }[] }>(
      `SELECT datname FROM pg_database WHERE datname LIKE ? AND datdba = (SELECT oid FROM pg_roles WHERE rolname = current_user)`,
      [`${WORKER_PREFIX}%`]
    )
    for (const { datname } of rows) {
      await knex.raw(`DROP DATABASE IF EXISTS ${assertDatabaseName(datname)} WITH (FORCE)`)
    }
  } finally {
    await knex.destroy()
  }
}
