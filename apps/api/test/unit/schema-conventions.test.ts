import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type * as Typebox from '@feathersjs/typebox'

// ADR 0005, 0030: every data and patch schema a service exports rejects
// fields it does not declare, the mass-assignment defence. A schema is found
// by its `$id`, which ends in `Data` or `Patch` as the generator names them.

// Importing a service module compiles its AJV validators, about 35 ms each
// and four or so per service: most of the walk's time, and none of it needed
// to read the schemas. The modules here get a getValidator that compiles
// nothing.
vi.mock('@feathersjs/typebox', async (importOriginal) => ({
  ...(await importOriginal<typeof Typebox>()),
  getValidator: () => async () => undefined
}))

// The walk still imports every service module and what it imports, so its
// time grows with the services a product adds and with the machine's load:
// about a second here alone, several times that in a busy CI run. The
// default 5 s is no measure of it.
const WALK_TIMEOUT = 30_000

const SERVICES = fileURLToPath(new URL('../../src/services', import.meta.url))

const modules = readdirSync(SERVICES, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.ts'))
  .map((file) => join(SERVICES, file))

const writeSchemas = async () => {
  const found: { id: string; additionalProperties: unknown }[] = []
  for (const file of modules) {
    const exported = (await import(pathToFileURL(file).href)) as Record<string, unknown>
    for (const value of Object.values(exported)) {
      if (!value || typeof value !== 'object') continue
      const { $id, additionalProperties } = value as { $id?: unknown; additionalProperties?: unknown }
      if (typeof $id === 'string' && /(Data|Patch)$/.test($id)) found.push({ id: $id, additionalProperties })
    }
  }
  return found
}

describe('service schemas', () => {
  it('reject unknown fields in every data and patch schema', async () => {
    const schemas = await writeSchemas()
    // The walk found the services' schemas, not nothing.
    expect(schemas.map((schema) => schema.id)).toEqual(expect.arrayContaining(['DocumentData', 'DocumentPatch', 'ErasureData']))
    expect(schemas.filter((schema) => schema.additionalProperties !== false).map((schema) => schema.id)).toEqual([])
  }, WALK_TIMEOUT)
})
