import type { CrossSettingContext } from '../settings/registry.js'
import type { SettingDefinition } from '../settings/define.js'

// The product's runtime settings (ADR 0025, 0035), each with define() from
// ../settings/define.js, merged into the skeleton's registry. The migrate job
// seeds their defaults; the web app explains each under `settings.help` in
// apps/web/src/i18n/product/. A key is stable once released.
export const PRODUCT_SETTINGS = {} satisfies Record<string, SettingDefinition>

type ProductSettingKey = keyof typeof PRODUCT_SETTINGS

// What the api and the worker refuse to start without.
export const PRODUCT_API_SETTINGS: readonly ProductSettingKey[] = []
export const PRODUCT_WORKER_SETTINGS: readonly ProductSettingKey[] = []

// Rules over two settings, checked on every write; each returns a message
// when violated.
export const PRODUCT_CROSS_SETTING_RULES: ReadonlyArray<(context: CrossSettingContext) => string | undefined> = []
