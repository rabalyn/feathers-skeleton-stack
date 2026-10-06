import { describe, expect, it } from 'vitest'
import type { RouteRecordRaw } from 'vue-router'
import { PRODUCT_NAV_LINKS } from '@/product/routes'
import routes from '@/router/routes'

// ADR 0035: the product's pages sit beside the skeleton's. A route name used
// twice would make one page unreachable, and a person's navigation order
// stores names.
const names = (records: readonly RouteRecordRaw[]): string[] =>
  records.flatMap((record) => [...(typeof record.name === 'string' ? [record.name] : []), ...names(record.children ?? [])])

describe('product routes', () => {
  it('uses every route name once', () => {
    const all = names(routes)
    expect(all.filter((name, index) => all.indexOf(name) !== index)).toEqual([])
  })

  it('links only to routes that exist', () => {
    const all = names(routes)
    expect(PRODUCT_NAV_LINKS.map((link) => link.name).filter((name) => !all.includes(name))).toEqual([])
  })
})
