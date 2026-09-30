import { createReadStream } from 'node:fs'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Writable } from 'node:stream'
import type { BackupConfig } from '../config.js'
import { PRODUCTION_BUCKETS, Storage } from '../storage.js'
import { objectKey } from './mirror.js'
import { restic, snapshotOf, type Repository } from './restic.js'

// The parts of a restore that need restic and the backup's own view of the
// repositories (ADR 0017). Writing into PostgreSQL, Valkey and OpenBao is
// done by scripts/backup.sh through those containers; objects are uploaded
// from here, with the backup key, which the script grants write access to
// the target bucket for the duration of the restore only.

// Writes one file of a snapshot to `out`: `app.dump` of `db`, `netbox.dump`
// of `netbox` (ADR 0031), or a file of the directory a `state` or `objects`
// snapshot holds.
export const dumpFile = async (config: BackupConfig, repository: Repository, name: string, out: Writable, id = 'latest') => {
  const snapshot = await snapshotOf(config, repository, id)
  const root = snapshot.paths[0] ?? '/'
  const path = root.endsWith(`/${name}`) ? root : join(root, name)
  await restic(config, repository, ['dump', snapshot.id, path], { stdout: out })
}

export interface ObjectRestoreOptions {
  bucket: string
  snapshot?: string
  // Removes every object first; refused for the buckets production has.
  empty?: boolean
}

export const restoreObjects = async (config: BackupConfig, options: ObjectRestoreOptions): Promise<number> => {
  if (options.empty && (PRODUCTION_BUCKETS as readonly string[]).includes(options.bucket)) {
    throw new Error(`refusing to empty ${options.bucket}: a production bucket`)
  }
  const snapshot = await snapshotOf(config, 'objects', options.snapshot)
  const staging = join(config.backupWorkDir, 'restore', 'objects')
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  const storage = new Storage({ ...config, s3UploadsBucket: options.bucket })
  try {
    await restic(config, 'objects', ['restore', '--quiet', `${snapshot.id}:${snapshot.paths[0]}`, '--target', staging])
    if (options.empty) await storage.empty()
    let restored = 0
    for (const name of await readdir(staging)) {
      if (name.startsWith('.')) continue
      const file = join(staging, name)
      // The database holds each file's verified type (ADR 0020); the object
      // itself is bytes.
      await storage.put(objectKey(name), createReadStream(file), (await stat(file)).size, 'application/octet-stream')
      restored++
    }
    return restored
  } finally {
    storage.close()
    await rm(staging, { recursive: true, force: true })
  }
}
