import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PRODUCT_QUEUES } from '../../src/product/jobs.js'
import { PRODUCT_MAIL_KINDS } from '../../src/product/mail.js'
import { PRODUCT_PERMISSIONS, PRODUCT_TOKEN_EXCLUDED_PERMISSIONS } from '../../src/product/permissions.js'
import { PRODUCT_PERSONAL_DATA } from '../../src/product/personal-data.js'
import { PRODUCT_PREFERENCES } from '../../src/product/preferences.js'
import { PRODUCT_SERVICES } from '../../src/product/services.js'
import { PRODUCT_API_SETTINGS, PRODUCT_CROSS_SETTING_RULES, PRODUCT_SETTINGS, PRODUCT_WORKER_SETTINGS } from '../../src/product/settings.js'

// ADR 0035: in the skeleton repository the product module stays empty, so
// that a product merging a skeleton version never conflicts in it. Skeleton
// code goes into the skeleton's own files; `pnpm gen:service` writes there
// when product.env names the skeleton. Runs where product.env is, which the
// CI image has (scripts/ci.sh, unit tests); in a product it checks nothing.
const productEnv = new URL('../../../../product.env', import.meta.url)
const product = existsSync(productEnv) ? /^PRODUCT=['"]?([^'"\s]+)/m.exec(readFileSync(productEnv, 'utf8'))?.[1] : undefined

describe.runIf(product === 'feathers-skeleton')("the skeleton's product module", () => {
  it('registers nothing', () => {
    expect(PRODUCT_SERVICES).toEqual([])
    expect(PRODUCT_PERMISSIONS).toEqual([])
    expect(PRODUCT_TOKEN_EXCLUDED_PERMISSIONS).toEqual([])
    expect(PRODUCT_PERSONAL_DATA).toEqual([])
    expect(PRODUCT_MAIL_KINDS).toEqual([])
    expect(PRODUCT_SETTINGS).toEqual({})
    expect(PRODUCT_API_SETTINGS).toEqual([])
    expect(PRODUCT_WORKER_SETTINGS).toEqual([])
    expect(PRODUCT_CROSS_SETTING_RULES).toEqual([])
    expect(PRODUCT_PREFERENCES).toEqual({})
    expect(PRODUCT_QUEUES).toEqual([])
  })
})
