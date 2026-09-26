import { existsSync } from 'node:fs'
import { stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Logger } from 'pino'
import { REPOSITORIES, repositoryDir, restic, type ResticPaths } from './restic.js'

// The backup target (ADR 0017): the NFS export in CI and production, a named
// volume locally. A run never creates a repository: an empty directory is
// what an NFS export that failed to mount looks like, and writing into it
// would fill the host's disk with the backups meant to protect it. The
// repositories are made once, by `init`, which a person or the local setup
// runs knowingly.

export class TargetError extends Error {}

const assertWritable = async (dir: string) => {
  const probe = join(dir, `.write-probe-${process.pid}`)
  try {
    await writeFile(probe, '')
    await unlink(probe)
  } catch (error) {
    throw new TargetError(`backup target ${dir} is not writable: ${(error as Error).message}`)
  }
}

// Before every run: every repository exists, and the target takes writes.
export const assertTarget = async (paths: ResticPaths): Promise<void> => {
  const missing = REPOSITORIES.filter((repository) => !existsSync(join(repositoryDir(paths, repository), 'config')))
  if (missing.length) {
    throw new TargetError(
      `backup target ${paths.backupTargetDir} holds no repository ${missing.join(', ')}: ` +
        'not mounted, or not initialised (node dist/backup.js init)'
    )
  }
  await assertWritable(paths.backupTargetDir)
}

// Creates the repositories that do not exist yet; idempotent.
export const initTarget = async (paths: ResticPaths, logger: Logger): Promise<void> => {
  const target = await stat(paths.backupTargetDir).catch(() => undefined)
  if (!target?.isDirectory()) throw new TargetError(`backup target ${paths.backupTargetDir} does not exist`)
  await assertWritable(paths.backupTargetDir)
  for (const repository of REPOSITORIES) {
    if (existsSync(join(repositoryDir(paths, repository), 'config'))) continue
    await restic(paths, repository, ['init', '--quiet'])
    logger.info({ repository }, 'repository initialised')
  }
}
