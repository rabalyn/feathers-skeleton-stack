import { useI18n } from 'vue-i18n'

// Dates in the current locale.
export const useFormat = () => {
  const { locale } = useI18n()
  const dateTime = (value: string | null | undefined) =>
    value ? new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : ''
  return { dateTime }
}
