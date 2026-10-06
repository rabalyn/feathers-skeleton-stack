import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import productDe from '@/i18n/product/de.json'
import productEn from '@/i18n/product/en.json'
import { PRODUCT_NAV_LINKS, PRODUCT_ROUTES } from '@/product/routes'

// ADR 0035: in the skeleton repository the web app's product module stays
// empty, as the api's does (apps/api/test/unit/product-stubs.test.ts).
const productEnv = new URL('../../../product.env', import.meta.url)
const product = existsSync(productEnv) ? /^PRODUCT=['"]?([^'"\s]+)/m.exec(readFileSync(productEnv, 'utf8'))?.[1] : undefined

describe.runIf(product === 'feathers-skeleton')("the skeleton's product module", () => {
  it('has no pages, links or messages', () => {
    expect(PRODUCT_ROUTES).toEqual([])
    expect(PRODUCT_NAV_LINKS).toEqual([])
    expect(productDe).toEqual({})
    expect(productEn).toEqual({})
  })
})
