import de from './de.json'
import en from './en.json'
import productDe from './product/de.json'
import productEn from './product/en.json'

// Message catalogues (ADR 0014). German is the default locale and the schema:
// English must have exactly its keys, which the i18n lint checks together
// with every key the code uses. Language names under `app.locales` are the
// same in every catalogue, each in its own language.
//
// A product's messages are in product/ (ADR 0035), merged into the
// skeleton's; they add keys and never replace one (test/product-i18n.test.ts).
export type MessageSchema = typeof de & typeof productDe

type Messages = { [key: string]: string | Messages }

// The product's keys into a copy of the skeleton's catalogue, nested objects
// merged.
export const mergeMessages = (base: Messages, extra: Messages): Messages => {
  const result: Messages = { ...base }
  for (const [key, value] of Object.entries(extra)) {
    const existing = result[key]
    result[key] = typeof value === 'object' && typeof existing === 'object' ? mergeMessages(existing, value) : value
  }
  return result
}

const catalogue = <T>(base: T, extra: object) => mergeMessages(base as Messages, extra as Messages) as T & typeof productDe

export const LOCALES = ['de', 'en'] as const
export type Locale = (typeof LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'de'

export default { de: catalogue(de, productDe), en: catalogue(en, productEn) } satisfies Record<Locale, MessageSchema>
