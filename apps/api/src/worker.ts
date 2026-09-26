import { ConfigError, WORKER_KEYS, loadConfig } from './config.js'
import { createKnex } from './db.js'
import { createInternalServer } from './internal.js'
import { startMaintenance, queueConnection } from './jobs/maintenance.js'
import { createLogger } from './logger.js'
import { createRegistry, observeKnexPool } from './metrics.js'
import { SHUTDOWN_GRACE_MS, closeServer, withDeadline } from './shutdown.js'
import { WORKER_SETTINGS } from './settings/registry.js'
import { SettingsError, SettingsStore } from './settings/store.js'
import { Storage } from './storage.js'

// The worker container (ADR 0024): the api's image, this entry point. It runs
// the jobs; the api only enqueues.
const main = async () => {
  let config
  try {
    config = await loadConfig(WORKER_KEYS)
  } catch (error) {
    // Refuse to start half-configured (ADR 0006).
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`)
      process.exit(1)
    }
    throw error
  }

  const logger = await createLogger('worker', config.logLevel, config.logFile)
  const knex = createKnex(config, { camelCase: true })
  const settings = new SettingsStore(knex)
  const storage = new Storage(config)

  // An environment never runs with a policy silently absent (ADR 0025).
  try {
    await settings.assertPresent(WORKER_SETTINGS)
  } catch (error) {
    if (error instanceof SettingsError) {
      logger.fatal(error.message)
      await knex.destroy()
      process.exit(1)
    }
    throw error
  }

  const metrics = createRegistry('worker')
  observeKnexPool(metrics, knex)
  const maintenance = startMaintenance({
    connection: queueConnection(config),
    knex,
    settings,
    storage,
    logger,
    metrics
  })
  await maintenance.schedule()
  const internal = createInternalServer({
    metrics,
    live: maintenance.isRunning,
    tls: { certFile: config.internalTlsCertFile, keyFile: config.internalTlsKeyFile }
  }).listen(config.internalPort)
  logger.info({ internalPort: config.internalPort }, 'worker running')

  // A running job gets SHUTDOWN_GRACE_MS to finish (ADR 0024). One cut off
  // keeps its lock until it expires; BullMQ then finds it stalled and runs
  // it again.
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down')
    setTimeout(() => {
      logger.error('shutdown did not finish in time')
      process.exit(1)
    }, SHUTDOWN_GRACE_MS + 2000).unref()
    const [, drained] = await Promise.all([
      closeServer(internal),
      withDeadline(
        maintenance.close().then(() => true),
        SHUTDOWN_GRACE_MS,
        () => logger.warn('running job cut off by shutdown')
      )
    ])
    // A job cut off still holds its connection, which destroy would wait for.
    if (drained) await knex.destroy()
    storage.close()
    process.exit(0)
  }
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT', () => void shutdown('SIGINT'))
}

await main()
