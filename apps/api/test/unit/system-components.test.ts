import { describe, expect, it } from 'vitest'
import { COMPONENTS, INVENTORY } from '../../src/system/components.js'
import { parseTag } from '../../src/system/versions.js'

// ADR 0032: the generated inventory and the components' metadata name the
// same components, and every declared version is a tag the comparison reads.

describe('components', () => {
  it('has metadata for every inventory entry and nothing more', () => {
    expect(COMPONENTS.map((component) => component.id).sort()).toEqual(INVENTORY.map((entry) => entry.id).sort())
  })

  it('reads every declared version as a version under its rule', () => {
    for (const entry of INVENTORY) {
      if (!entry.version) continue
      const component = COMPONENTS.find((candidate) => candidate.id === entry.id)!
      expect(parseTag(entry.version, component.rule), entry.id).not.toBeNull()
    }
  })
})
