import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LOGOS } from '../../src/branding.js'

// ADR 0035: the logos a product adds are PNGs a PDF can embed; the
// skeleton ships none.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('branding', () => {
  it('has each logo present as a PNG', () => {
    for (const path of Object.values(LOGOS)) {
      if (path) expect(readFileSync(path).subarray(0, 8)).toEqual(PNG)
    }
  })
})
