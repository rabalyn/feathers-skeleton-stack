// The languages of the application (ADR 0014): German first and the
// default, English second. Mail reaches a person in the one they last used
// in the web app (ADR 0027). Browser-safe: the client entry point exports it.

export const LOCALES = ['de', 'en'] as const
export type Locale = (typeof LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'de'
