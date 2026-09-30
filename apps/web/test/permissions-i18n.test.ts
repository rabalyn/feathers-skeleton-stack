import { PERMISSIONS } from '@app/api/client'
import { describe, expect, it } from 'vitest'
import de from '@/i18n/de.json'
import en from '@/i18n/en.json'

// ADR 0011: every catalogue permission has a label and a description in
// every locale, and every group a label, or the permissions page would show
// raw keys. Keys replace dots, which vue-i18n reads as nesting.
const slug = (key: string) => key.replace(/\./g, '_')

describe.each([
  ['de', de],
  ['en', en]
])('%s', (_locale, messages) => {
  const { keys, descriptions, groups } = messages.permissions as {
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
