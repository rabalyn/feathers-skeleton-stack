import { describe, expect, it } from 'vitest'
import de from '@/i18n/de.json'
import en from '@/i18n/en.json'
import messages, { mergeMessages } from '@/i18n'
import productDe from '@/i18n/product/de.json'
import productEn from '@/i18n/product/en.json'

// ADR 0035: a product's catalogues add keys to the skeleton's and never
// replace one, so the skeleton's screens keep the wording the skeleton gives
// them, and a skeleton key that changes meaning cannot leave a stale
// product text behind. Both product catalogues have the same keys, as the
// skeleton's do (ADR 0014).

type Tree = { [key: string]: string | Tree }

// Every message's path, e.g. `permissions.keys.foo_manage`.
const paths = (tree: Tree, prefix = ''): string[] =>
  Object.entries(tree).flatMap(([key, value]) => (typeof value === 'string' ? [`${prefix}${key}`] : paths(value, `${prefix}${key}.`)))

describe.each([
  ['de', de, productDe],
  ['en', en, productEn]
])('%s', (_locale, skeleton, product) => {
  it('adds keys only', () => {
    const own = new Set(paths(skeleton))
    expect(paths(product as Tree).filter((path) => own.has(path))).toEqual([])
  })

  it('never nests keys below a skeleton message', () => {
    const own = new Set(paths(skeleton))
    const shadowed = paths(product as Tree).filter((path) => [...own].some((message) => path.startsWith(`${message}.`)))
    expect(shadowed).toEqual([])
  })
})

it('gives the product catalogues the same keys', () => {
  expect(paths(productEn as Tree).sort()).toEqual(paths(productDe as Tree).sort())
})

it('merges nested objects', () => {
  expect(mergeMessages({ a: { b: 'x' }, c: 'y' }, { a: { d: 'z' } })).toEqual({ a: { b: 'x', d: 'z' }, c: 'y' })
})

it('serves every skeleton message unchanged', () => {
  expect(paths(messages.de as Tree)).toEqual(expect.arrayContaining(paths(de as Tree)))
})
