import { PERMISSIONS } from '@app/api/client'
import { describe, expect, it } from 'vitest'
import messages from '@/i18n'

// ADR 0011: every catalogue permission has a label and a description in
// every locale, and every group a label, or the permissions page would show
// raw keys. Keys replace dots, which vue-i18n reads as nesting. The product's
// permissions are labelled in its own catalogues (ADR 0035), merged here.
const slug = (key: string) => key.replace(/\./g, '_')

describe.each(Object.entries(messages))('%s', (_locale, catalogue) => {
  const { keys, descriptions, groups } = catalogue.permissions as {
    keys: Record<string, string>
    descriptions: Record<string, string>
    groups: Record<string, string>
  }

  it.each(PERMISSIONS.map((entry) => entry.key))('labels and describes %s', (key) => {
    expect(keys[slug(key)]).toBeTruthy()
    expect(descriptions[slug(key)]).toBeTruthy()
  })

  it('labels every group', () => {
    for (const group of new Set(PERMISSIONS.map((entry) => entry.group))) expect(groups[group], group).toBeTruthy()
  })

  it('has nothing for a permission the catalogue no longer declares', () => {
    const declared = PERMISSIONS.map((entry) => slug(entry.key)).sort()
    expect(Object.keys(keys).sort()).toEqual(declared)
    expect(Object.keys(descriptions).sort()).toEqual(declared)
  })
})
