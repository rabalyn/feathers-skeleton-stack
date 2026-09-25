import de from './de.json'
import en from './en.json'

// Message catalogues (ADR 0014). German is the default locale and the schema:
// English must have exactly its keys, which the i18n lint checks together
// with every key the code uses. Language names under `app.locales` are the
// same in every catalogue, each in its own language.
export type MessageSchema = typeof de

export const LOCALES = ['de', 'en'] as const
export type Locale = (typeof LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'de'

export default { de, en } satisfies Record<Locale, MessageSchema>
