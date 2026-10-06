import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SETTING_KEYS } from '../../src/settings/registry.js'

// ADR 0025: every registered runtime setting, the product's included
// (ADR 0035), is described in every locale of the web app, or the settings
// page would show a key without its explanation. Here rather than in the web
// app, which cannot import the registry: it is server code.
type Catalogue = { settings?: { help?: Record<string, string> } }
const catalogue = (path: string) => JSON.parse(readFileSync(new URL(`../../../web/src/i18n/${path}`, import.meta.url), 'utf8')) as Catalogue

describe.each(['de', 'en'])('%s', (locale) => {
  const help = { ...catalogue(`${locale}.json`).settings?.help, ...catalogue(`product/${locale}.json`).settings?.help }

  it.each(SETTING_KEYS)('describes %s', (key) => {
    expect(help[key]).toBeTruthy()
  })

  it('has nothing for a setting the registry no longer declares', () => {
    expect(Object.keys(help).sort()).toEqual([...SETTING_KEYS].sort())
  })
})
