import { createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Storage } from '../storage.js'

// The uploads bucket as a directory restic can back up (ADR 0017, 0020): one
// file per object, named by its key. Objects are immutable, so an object
// whose file exists with its size is not fetched again; files whose object
// is gone are removed. A run downloads only what is new since the last.

export interface MirrorResult {
  objects: number
  downloaded: number
  removed: number
}

// Keys are UUIDs; encoded anyway, so no key can name a path or a dot file.
export const fileName = (key: string) => encodeURIComponent(key).replace(/^\./, '%2E')
export const objectKey = (name: string) => decodeURIComponent(name)

const PARTIAL = '.partial-'

export const syncMirror = async (storage: Storage, dir: string): Promise<MirrorResult> => {
  await mkdir(dir, { recursive: true })
  const present = new Map<string, number>()
  for (const name of await readdir(dir)) {
    if (name.startsWith(PARTIAL)) await rm(join(dir, name), { force: true })
    else present.set(name, (await stat(join(dir, name))).size)
  }

  const seen = new Set<string>()
  let downloaded = 0
  for await (const page of storage.list()) {
    for (const object of page) {
      const name = fileName(object.key)
      seen.add(name)
      if (present.get(name) === object.size) continue
      const stored = await storage.get(object.key)
      // Deleted since the listing: the next run no longer sees it either.
      if (!stored) continue
      const partial = join(dir, PARTIAL + name)
      await pipeline(stored.body, createWriteStream(partial))
      await rename(partial, join(dir, name))
      downloaded++
    }
  }

  let removed = 0
  for (const name of present.keys()) {
    if (seen.has(name)) continue
    await rm(join(dir, name), { force: true })
    removed++
  }
  return { objects: seen.size, downloaded, removed }
}
