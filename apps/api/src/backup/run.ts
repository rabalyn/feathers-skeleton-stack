import { readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Logger } from 'pino'
import type { BackupConfig } from '../config.js'
import type { SettingsStore } from '../settings/store.js'
import type { Storage } from '../storage.js'
import { syncMirror } from './mirror.js'
import { REPOSITORIES, SNAPSHOT_HOST, restic, summary, type Repository } from './restic.js'
import { clearState, stageState } from './state.js'
import { assertTarget } from './target.js'

// One backup run (ADR 0017): the three repositories, each on its own and in
// any order, since database and objects need no coordination (ADR 0020).
// Each is followed by its retention. A repository that fails does not stop
// the others; the run then ends with an error line per failure and without
// the success line, which is what the alerts look for (ADR 0022).

export const DUMP_FILE = 'app.dump'

export interface BackupContext {
  config: BackupConfig
  settings: SettingsStore
  storage: Storage
  logger: Logger
}

export const mirrorDir = (config: BackupConfig) => join(config.backupWorkDir, 'mirror', config.s3UploadsBucket)
export const stateDir = (config: BackupConfig) => join(config.backupWorkDir, 'state')

const backupDatabase = async ({ config }: BackupContext) => {
  // Direct to PostgreSQL, verified, as the read-only `backup` role (ADR
  // 0004). The password reaches pg_dump alone, through its environment.
  const connection = [
    `host=${config.databaseHost}`,
    `port=${config.databasePort}`,
    `dbname=${config.databaseName}`,
    `user=${config.databaseUser}`,
    'sslmode=verify-full',
    `sslrootcert=${config.databaseCaFile}`
  ].join(' ')
  // Uncompressed: restic compresses, and deduplicates what is unchanged.
  // A pg_dump that fails fails the snapshot (--stdin-from-command).
  return restic(
    config,
    'db',
    ['backup', '--json', '--quiet', '--host', SNAPSHOT_HOST, '--stdin-filename', DUMP_FILE, '--stdin-from-command', '--',
      'pg_dump', '--format=custom', '--compress=0', '--no-password', `--dbname=${connection}`],
    { env: { PGPASSWORD: config.databasePassword } }
  )
}

const backupObjects = async ({ config, storage, logger }: BackupContext) => {
  const mirror = await syncMirror(storage, mirrorDir(config))
  logger.info({ repository: 'objects', bucket: config.s3UploadsBucket, ...mirror }, 'bucket mirrored')
  return restic(config, 'objects', ['backup', '--json', '--quiet', '--host', SNAPSHOT_HOST, mirrorDir(config)])
}

const backupState = async ({ config }: BackupContext) => {
  const dir = stateDir(config)
  try {
    await stageState(config, dir)
    return await restic(config, 'state', ['backup', '--json', '--quiet', '--host', SNAPSHOT_HOST, dir])
  } finally {
    await clearState(dir)
  }
}

const STEPS: Record<Repository, (context: BackupContext) => Promise<string>> = {
  db: backupDatabase,
  objects: backupObjects,
  state: backupState
}

const forget = (config: BackupConfig, repository: Repository, keepDaily: number) =>
  restic(config, repository, ['forget', '--quiet', '--host', SNAPSHOT_HOST, '--keep-daily', String(keepDaily), '--prune'])

// Returns whether every repository was backed up.
export const runBackup = async (context: BackupContext): Promise<boolean> => {
  const { config, settings, logger } = context
  const started = Date.now()
  try {
    await assertTarget(config)
  } catch (error) {
    logger.error({ err: { message: (error as Error).message } }, 'backup failed')
    return false
  }

  const failed: Repository[] = []
  for (const repository of REPOSITORIES) {
    try {
      const result = summary(await STEPS[repository](context))
      logger.info(
        {
          repository,
          snapshot_id: result.snapshot_id,
          files_new: result.files_new,
          data_added: result.data_added,
          duration_ms: Math.round(Number(result.total_duration ?? 0) * 1000)
        },
        'repository backed up'
      )
      await forget(config, repository, await settings.get('backupRetentionDailySnapshots'))
    } catch (error) {
      failed.push(repository)
      logger.error({ repository, err: { message: (error as Error).message } }, 'backup failed')
    }
  }
  if (failed.length) return false
  logger.info({ repositories: REPOSITORIES, duration_ms: Date.now() - started }, 'backup completed')
  return true
}

export class BusyError extends Error {}

// One run at a time per container, whether scheduled or started by hand:
// they share the mirror and the staged state.
export const withRunLock = async <T>(workDir: string, work: () => Promise<T>): Promise<T> => {
  const lock = join(workDir, 'run.lock')
  const holder = Number(await readFile(lock, 'utf8').catch(() => ''))
  if (holder && holder !== process.pid) {
    let alive = true
    try {
      process.kill(holder, 0)
    } catch {
      alive = false
    }
    if (alive) throw new BusyError(`a backup run is in progress (pid ${holder})`)
  }
  await writeFile(lock, String(process.pid))
  try {
    return await work()
  } finally {
    await unlink(lock).catch(() => {})
  }
}
