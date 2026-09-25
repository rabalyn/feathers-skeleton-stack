import { createApp } from './app.js'
import { API_KEYS, ConfigError, loadConfig } from './config.js'
import { createKnex } from './db.js'
import { createInternalServer } from './internal.js'
import { createLogger } from './logger.js'
import { createValkey } from './valkey.js'
import { API_SETTINGS } from './settings/registry.js'
import { SettingsError } from './settings/store.js'

const main = async () => {
  let config
  try {
    config = await loadConfig(API_KEYS)
  } catch (error) {
    // Refuse to start half-configured (ADR 0006).
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`)
      process.exit(1)
    }
    throw error
  }

  const logger = createLogger('api', config.logLevel)
  const valkey = createValkey(config)
  // Unreachable Valkey is not a reason to exit: rate-limited attempts are
  // refused until it is back (ADR 0010).
  valkey.on('error', (err: Error) => logger.warn({ err: { message: err.message } }, 'valkey unavailable'))
  const app = createApp(config, logger, createKnex(config, { camelCase: true }), valkey)

  // An environment never runs with a policy silently absent (ADR 0025).
  try {
    await app.get('settings').assertPresent(API_SETTINGS)
  } catch (error) {
    if (error instanceof SettingsError) {
      logger.fatal(error.message)
      await app.teardown()
      process.exit(1)
    }
    throw error
  }

  await app.listen(config.port)
  createInternalServer().listen(config.internalPort)
  logger.info({ port: config.port, internalPort: config.internalPort }, 'api listening')

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down')
    await app.teardown()
    process.exit(0)
  }
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT', () => void shutdown('SIGINT'))
}

await main()
