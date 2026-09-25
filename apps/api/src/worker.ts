import { ConfigError, WORKER_KEYS, loadConfig } from './config.js'
import { createKnex } from './db.js'
import { createInternalServer } from './internal.js'
import { startMaintenance, queueConnection } from './jobs/maintenance.js'
import { createLogger } from './logger.js'
import { WORKER_SETTINGS } from './settings/registry.js'
import { SettingsError, SettingsStore } from './settings/store.js'

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

  const logger = createLogger('worker', config.logLevel)
  const knex = createKnex(config, { camelCase: true })
  const settings = new SettingsStore(knex)

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

  const maintenance = startMaintenance({ connection: queueConnection(config), knex, settings, logger })
  await maintenance.schedule()
  const internal = createInternalServer(maintenance.isRunning).listen(config.internalPort)
  logger.info({ internalPort: config.internalPort }, 'worker running')

  // Lets a running job finish before exiting.
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down')
    internal.close()
    await maintenance.close()
    await knex.destroy()
    process.exit(0)
  }
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT', () => void shutdown('SIGINT'))
}

await main()
