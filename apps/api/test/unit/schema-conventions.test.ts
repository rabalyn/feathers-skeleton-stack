import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

// ADR 0005, 0030: every data and patch schema a service exports rejects
// fields it does not declare, the mass-assignment defence. A schema is found
// by its `$id`, which ends in `Data` or `Patch` as the generator names them.

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
  })
})
