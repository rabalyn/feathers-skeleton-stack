import { useI18n } from 'vue-i18n'

// Dates and sizes in the current locale.
export const useFormat = () => {
  const { locale } = useI18n()
  const dateTime = (value: string | null | undefined) =>
    value ? new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : ''
  // Decimal units, as the quota settings count them (ADR 0020).
  const bytes = (value: number | null | undefined) => {
    if (value === null || value === undefined) return ''
    const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const
    const exponent = Math.min(Math.floor(Math.log10(Math.max(value, 1)) / 3), units.length - 1)
    return new Intl.NumberFormat(locale.value, {
      style: 'unit',
      unit: units[exponent],
      maximumFractionDigits: exponent === 0 ? 0 : 1
    }).format(value / 1000 ** exponent)
  }
  return { dateTime, bytes }
}
