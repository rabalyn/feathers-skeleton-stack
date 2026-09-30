import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Writable } from 'node:stream'

// restic as a child process (ADR 0017). Each repository is a directory of
// the backup target; the password comes from RESTIC_PASSWORD_FILE, which
// restic reads itself, so it never passes through an argument.

// `netbox` holds NetBox's database (ADR 0031), apart from `db` so that the
// latest snapshot of each is one dump.
export const REPOSITORIES = ['db', 'objects', 'state', 'netbox'] as const
export type Repository = (typeof REPOSITORIES)[number]

// Every snapshot is taken under this host name, so retention groups them the
// same whatever the container is called.
export const SNAPSHOT_HOST = 'backup'

export class ResticError extends Error {}

export interface ResticPaths {
  backupTargetDir: string
  backupWorkDir: string
}

export interface ResticCall {
  // Extra environment for this call only (pg_dump's password, ADR 0023).
  env?: NodeJS.ProcessEnv
  // Where stdout goes instead of being collected and returned (`dump`).
  stdout?: Writable
}

export interface Snapshot {
  id: string
  short_id: string
  time: string
  paths: string[]
}

// Children still running, so a shutdown can interrupt them: restic removes
// its lock on SIGINT, and passes the signal on to pg_dump.
const running = new Set<ChildProcess>()
export const interruptRunning = () => {
  for (const child of running) child.kill('SIGINT')
}

const STDERR_KEPT = 4096

export const repositoryDir = (paths: ResticPaths, repository: Repository) => join(paths.backupTargetDir, repository)

export const restic = (paths: ResticPaths, repository: Repository, args: string[], call: ResticCall = {}): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      'restic',
      ['--repo', repositoryDir(paths, repository), '--cache-dir', join(paths.backupWorkDir, 'cache'), ...args],
      { env: { ...process.env, ...call.env }, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    running.add(child)
    let stdout = ''
    let stderr = ''
    if (call.stdout) child.stdout.pipe(call.stdout, { end: false })
    else child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-STDERR_KEPT)))
    child.on('error', (error) => {
      running.delete(child)
      reject(new ResticError(`restic ${args[0]} on ${repository}: ${error.message}`))
    })
    child.on('close', (code, signal) => {
      running.delete(child)
      if (code === 0) return resolve(stdout)
      const detail = stderr.trim().split('\n').slice(-3).join('; ')
      reject(new ResticError(`restic ${args[0]} on ${repository} failed (${signal ?? `exit ${code}`}): ${detail}`))
    })
  })

// The last line restic prints with --json --quiet: the summary of a backup.
export const summary = (output: string): Record<string, unknown> => {
  const line = output.trim().split('\n').at(-1) ?? '{}'
  try {
    return JSON.parse(line) as Record<string, unknown>
  } catch {
    return {}
  }
}

export const snapshotOf = async (paths: ResticPaths, repository: Repository, id = 'latest'): Promise<Snapshot> => {
  const output = await restic(paths, repository, ['snapshots', '--json', '--host', SNAPSHOT_HOST, id])
  const [snapshot] = JSON.parse(output) as Snapshot[]
  if (!snapshot) throw new ResticError(`no snapshot ${id} in ${repository}`)
  return snapshot
}
