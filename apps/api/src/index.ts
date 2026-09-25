import { createApp } from './app.js'
import { API_KEYS, ConfigError, loadConfig } from './config.js'
import { createKnex } from './db.js'
import { createInternalServer } from './internal.js'
import { createLogger } from './logger.js'
import { createValkey } from './valkey.js'
import { SHUTDOWN_GRACE_MS, closeServer } from './shutdown.js'
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

  const logger = await createLogger('api', config.logLevel, config.logFile)
  const valkey = createValkey(config)
  // Unreachable Valkey is not a reason to exit: rate-limited attempts are
  // refused until it is back (ADR 0010).
  valkey.on('error', (err: Error) => logger.warn({ err: { message: err.message } }, 'valkey unavailable'))
  const app = createApp(config, logger, createKnex(config, { camelCase: true }), valkey, {
    rateLimitPrefix: config.rateLimitPrefix
  })

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
  const internal = createInternalServer({
    metrics: app.get('metrics'),
    tls: { certFile: config.internalTlsCertFile, keyFile: config.internalTlsKeyFile }
  }).listen(config.internalPort)
  logger.info({ port: config.port, internalPort: config.internalPort }, 'api listening')

  // Requests in flight get SHUTDOWN_GRACE_MS (ADR 0006); should closing
  // still hang past it, the process exits anyway, before Podman's SIGKILL.
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down')
    setTimeout(() => {
      logger.error('shutdown did not finish in time')
      process.exit(1)
    }, SHUTDOWN_GRACE_MS + 2000).unref()
    await Promise.all([closeServer(internal), app.teardown()])
    process.exit(0)
  }
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT', () => void shutdown('SIGINT'))
}

await main()
