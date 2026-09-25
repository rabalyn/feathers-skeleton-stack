import { ConfigError, MIGRATE_KEYS, loadConfig } from './config.js'
import { createKnex } from './db.js'
import { createLogger } from './logger.js'

// One-shot migration job (ADR 0003). Connects directly to PostgreSQL as the
// migrator role, never through PgBouncer.
//
//   node dist/migrate.js                  migrate DATABASE_NAME
//   node dist/migrate.js --test-template  recreate and migrate test_template
//                                         (ADR 0015)

export const TEST_TEMPLATE = 'test_template'

const migrationsConfig = {
  directory: new URL('./migrations', import.meta.url).pathname,
  loadExtensions: ['.js'],
  tableName: 'knex_migrations'
}

const main = async () => {
  let config
  try {
    config = await loadConfig(MIGRATE_KEYS)
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`)
      process.exit(1)
    }
    throw error
  }
  const logger = createLogger('migrate', config.logLevel)
  const testTemplate = process.argv.includes('--test-template')
  const database = testTemplate ? TEST_TEMPLATE : config.databaseName

  if (testTemplate) {
    const admin = createKnex({ ...config, databaseName: 'postgres', databasePoolMax: 1 })
    try {
      // A template database cannot be dropped until it is unmarked.
      await admin.raw(
        `DO $$ BEGIN
           IF EXISTS (SELECT FROM pg_database WHERE datname = '${TEST_TEMPLATE}') THEN
             ALTER DATABASE ${TEST_TEMPLATE} WITH IS_TEMPLATE false;
           END IF;
         END $$`
      )
      await admin.raw(`DROP DATABASE IF EXISTS ${TEST_TEMPLATE} WITH (FORCE)`)
      await admin.raw(`CREATE DATABASE ${TEST_TEMPLATE} OWNER migrator`)
      logger.info({ database }, 'recreated test template')
    } finally {
      await admin.destroy()
    }
  }

  // A direct connection, so session settings are allowed here (ADR 0004
  // restricts only pooled connections). Schema work may wait for locks, but
  // never indefinitely.
  const knex = createKnex(
    { ...config, databaseName: database, databasePoolMax: 1 },
    {
      pool: {
        min: 0,
        max: 1,
        afterCreate: (conn: { query: (sql: string, cb: (err: Error | null) => void) => void }, done: (err: Error | null, conn: unknown) => void) =>
          conn.query("SET lock_timeout = '10s'", (err) => done(err, conn))
      }
    }
  )
  try {
    const [batch, applied] = (await knex.migrate.latest(migrationsConfig)) as [number, string[]]
    logger.info({ database, batch, applied }, applied.length ? 'migrations applied' : 'schema up to date')
  } finally {
    await knex.destroy()
  }

  if (testTemplate) {
    const admin = createKnex({ ...config, databaseName: 'postgres', databasePoolMax: 1 })
    try {
      // Lets the test role clone it without owning it.
      await admin.raw(`ALTER DATABASE ${TEST_TEMPLATE} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`)
    } finally {
      await admin.destroy()
    }
  }
}

await main()
