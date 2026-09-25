import { defineBoot } from '#q-app'
import { Quasar, type QuasarLanguage } from 'quasar'
import { createI18n } from 'vue-i18n'
import messages, { DEFAULT_LOCALE, LOCALES, type Locale, type MessageSchema } from '@/i18n'

// ADR 0014: German by default, English second; every string goes through
// here, including Quasar's own component texts.

/* eslint-disable @typescript-eslint/no-empty-object-type */
declare module 'vue-i18n' {
  export interface DefineLocaleMessage extends MessageSchema {}
  export interface DefineDateTimeFormat {}
  export interface DefineNumberFormat {}
}
/* eslint-enable @typescript-eslint/no-empty-object-type */

// A display preference, not personal data.
const STORAGE_KEY = 'app:locale'

const isLocale = (value: unknown): value is Locale => LOCALES.includes(value as Locale)

const storedLocale = (): Locale => {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return isLocale(value) ? value : DEFAULT_LOCALE
  } catch {
    return DEFAULT_LOCALE
  }
}

export const i18n = createI18n<[MessageSchema], Locale, false>({
  legacy: false,
  locale: storedLocale(),
  fallbackLocale: DEFAULT_LOCALE,
  messages
})

// Quasar's own component texts, loaded with the locale.
const quasarPacks: Record<Locale, () => Promise<{ default: QuasarLanguage }>> = {
  de: () => import('quasar/lang/de-DE'),
  en: () => import('quasar/lang/en-US')
}

export const setLocale = async (locale: Locale) => {
  const pack = await quasarPacks[locale]()
  Quasar.lang.set(pack.default)
  i18n.global.locale.value = locale
  document.documentElement.lang = locale
  try {
    localStorage.setItem(STORAGE_KEY, locale)
  } catch {
    // Private mode: the choice lasts for this page only.
  }
}

export default defineBoot(async ({ app }) => {
  app.use(i18n)
  await setLocale(i18n.global.locale.value)
})
