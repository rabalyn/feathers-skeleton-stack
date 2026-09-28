import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { createWriteStream, readFileSync } from 'node:fs'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { get } from 'node:https'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'

// The `state` repository (ADR 0017): Valkey's RDB snapshot, copied from a
// read-only mount of its volume (ADR 0010), and OpenBao's raft snapshot,
// fetched through its API with a token whose policy allows only that and the
// service's own secrets (ADR 0023). Both are staged as files, backed up
// together, and the staged copies removed.

export const VALKEY_FILE = 'valkey.rdb'
export const OPENBAO_FILE = 'openbao.snap'

export interface StateConfig {
  valkeySnapshotFile: string
  openbaoAddr: string
  openbaoTokenFile: string
  openbaoCaFile: string
}

const fetchOpenbaoSnapshot = async (config: StateConfig, file: string): Promise<void> => {
  // Read at every run: the agent renews the token and rewrites the file.
  const token = (await readFile(config.openbaoTokenFile, 'utf8')).trim()
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    get(
      `${config.openbaoAddr}/v1/sys/storage/raft/snapshot`,
      { ca: readFileSync(config.openbaoCaFile, 'utf8'), headers: { 'X-Vault-Token': token }, timeout: 60_000 },
      resolve
    )
      .on('timeout', function (this: ClientRequest) {
        this.destroy(new Error('timed out'))
      })
      .on('error', reject)
  })
  if (response.statusCode !== 200) {
    let body = ''
    for await (const chunk of response) body += (chunk as Buffer).toString()
    throw new Error(`OpenBao snapshot refused (${response.statusCode}): ${body.slice(0, 200).trim()}`)
  }
  await pipeline(response, createWriteStream(file, { mode: 0o600 }))
}

export const stageState = async (config: StateConfig, dir: string): Promise<void> => {
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true, mode: 0o700 })
  try {
    await copyFile(config.valkeySnapshotFile, join(dir, VALKEY_FILE))
  } catch (error) {
    throw new Error(`no Valkey snapshot to back up: ${(error as Error).message}`, { cause: error })
  }
  await fetchOpenbaoSnapshot(config, join(dir, OPENBAO_FILE))
}

export const clearState = (dir: string) => rm(dir, { recursive: true, force: true })
