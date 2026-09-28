import { destination, pino } from 'pino'
import { BACKUP_KEYS, ConfigError, loadConfig } from './config.js'
import { createKnex } from './db.js'
import { createLogger, loggerOptions } from './logger.js'
import { dumpFile, restoreObjects } from './backup/restore.js'
import { REPOSITORIES, interruptRunning, restic, type Repository } from './backup/restic.js'
import { BusyError, runBackup, withRunLock, type BackupContext } from './backup/run.js'
import { BACKUP_TIMEZONE, nextRun } from './backup/schedule.js'
import { initTarget } from './backup/target.js'
import { SHUTDOWN_GRACE_MS, withDeadline } from './shutdown.js'
import { BACKUP_SETTINGS } from './settings/registry.js'
import { SettingsError, SettingsStore } from './settings/store.js'
import { Storage } from './storage.js'

// The backup service (ADR 0017): the api's code base, its own image with
// restic and pg_dump, its own container, UID and credentials. It schedules
// itself from the runtime settings and cannot be triggered from the
// application; an administrator on the host can, with `run`.
//
//   node dist/backup.js            the service: a run whenever the schedule
//                                  (backupSchedule) comes due
//   node dist/backup.js init       create the repositories on the target;
//                                  once per target, knowingly
//   node dist/backup.js run        one run now
//   node dist/backup.js snapshots  list every repository's snapshots
//   node dist/backup.js dump <repository> <file> [<snapshot>]
//                                  write a file of a snapshot to stdout
//   node dist/backup.js restore-objects --bucket <name> [--snapshot <id>] [--empty]
//                                  upload a snapshot's objects to a bucket
//
// Restores are driven by scripts/backup.sh, which calls the last two.

const TICK_MS = 30_000

const fail = (message: string): never => {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

const option = (args: string[], name: string) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

const main = async () => {
  // Files on the target and in the work volume belong to the backup user; a
  // root `podman exec` would leave files it cannot touch.
  if (process.getuid?.() === 0) fail('refusing to run as root; use: podman exec -u backup backup node dist/backup.js ...')

  const [command = 'serve', ...args] = process.argv.slice(2)
  let config
  try {
    config = await loadConfig(BACKUP_KEYS)
  } catch (error) {
    if (error instanceof ConfigError) fail(error.message)
    throw error
  }

  // `dump` writes the file to stdout, so its log lines go to stderr only.
  if (command === 'dump') {
    const [repository, name, snapshot] = args
    if (!REPOSITORIES.includes(repository as Repository) || !name) fail('usage: dump <db|objects|state> <file> [<snapshot>]')
    await dumpFile(config, repository as Repository, name!, process.stdout, snapshot)
    return
  }
  if (command === 'snapshots') {
    for (const repository of REPOSITORIES) {
      process.stdout.write(`== ${repository}\n`)
      await restic(config, repository, ['snapshots', '--compact'], { stdout: process.stdout })
    }
    return
  }

  const logger =
    command === 'restore-objects'
      ? pino(loggerOptions('backup', config.logLevel), destination(2))
      : await createLogger('backup', config.logLevel, config.logFile)

  if (command === 'init') {
    await initTarget(config, logger)
    logger.info({ target: config.backupTargetDir }, 'backup target initialised')
    return
  }
  if (command === 'restore-objects') {
    const bucket = option(args, '--bucket') ?? fail('usage: restore-objects --bucket <name> [--snapshot <id>] [--empty]')
    const restored = await restoreObjects(config, { bucket, snapshot: option(args, '--snapshot'), empty: args.includes('--empty') })
    logger.info({ bucket, restored }, 'objects restored')
    return
  }
  if (command !== 'run' && command !== 'serve') fail(`unknown command ${command}`)

  const knex = createKnex({ ...config, databasePoolMax: 1 }, { camelCase: true })
  const settings = new SettingsStore(knex)
  const storage = new Storage(config)
  const context: BackupContext = { config, settings, storage, logger }
  const close = async () => {
    await knex.destroy()
    storage.close()
  }

  // An environment never runs with a policy silently absent (ADR 0025).
  const refuse = async (message: string) => {
    logger.fatal(message)
    await close()
    process.exit(1)
  }
  try {
    await settings.assertPresent(BACKUP_SETTINGS)
  } catch (error) {
    if (!(error instanceof SettingsError)) throw error
    await refuse(error.message)
  }
  try {
    nextRun(await settings.get('backupSchedule'), new Date())
  } catch (error) {
    await refuse(`runtime setting backupSchedule is not a cron expression: ${(error as Error).message}`)
  }

  if (command === 'run') {
    let ok = false
    try {
      ok = await withRunLock(config.backupWorkDir, () => runBackup(context))
    } catch (error) {
      if (!(error instanceof BusyError)) throw error
      logger.error(error.message)
    }
    await close()
    process.exit(ok ? 0 : 1)
  }

  // The service. The schedule is re-read every tick, so a changed setting
  // takes effect without a restart (ADR 0025).
  let schedule = await settings.get('backupSchedule')
  let next = nextRun(schedule, new Date())
  let timer: NodeJS.Timeout | undefined
  let current: Promise<unknown> | undefined
  let stopping = false
  logger.info({ schedule, timezone: BACKUP_TIMEZONE, next: next.toISOString() }, 'backup service running')

  const tick = async () => {
    try {
      const latest = await settings.get('backupSchedule')
      if (latest !== schedule) {
        next = nextRun(latest, new Date())
        schedule = latest
        logger.info({ schedule, next: next.toISOString() }, 'backup schedule changed')
      }
    } catch (error) {
      logger.error({ err: { message: (error as Error).message } }, 'cannot read the backup schedule')
    }
    if (Date.now() >= next.getTime()) {
      current = withRunLock(config.backupWorkDir, () => runBackup(context)).catch((error: Error) =>
        logger.error({ err: { message: error.message } }, 'backup failed')
      )
      await current
      current = undefined
      next = nextRun(schedule, new Date())
      logger.info({ next: next.toISOString() }, 'next backup scheduled')
    }
    if (!stopping) timer = setTimeout(() => void tick(), TICK_MS)
  }
  timer = setTimeout(() => void tick(), TICK_MS)

  // A run in progress is interrupted: restic removes its lock, the next
  // run starts over. The missing success line is what the alert sees.
  const shutdown = async (signal: string) => {
    stopping = true
    clearTimeout(timer)
    logger.info({ signal }, 'shutting down')
    if (current) {
      logger.warn('backup run interrupted by shutdown')
      interruptRunning()
      await withDeadline(current, SHUTDOWN_GRACE_MS)
    }
    await close()
    process.exit(0)
  }
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT', () => void shutdown('SIGINT'))
}

await main()
