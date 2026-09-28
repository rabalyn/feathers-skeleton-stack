import { useI18n } from 'vue-i18n'

// Audit actions (ADR 0013) by their label in the current locale; an action
// without one shows as recorded. Keys replace the dots of an action, which
// vue-i18n would read as nesting.
export const useAuditLabels = () => {
  const i18n = useI18n()
  const action = (value: string) => {
    const key = `audit.actions.${value.replace(/\./g, '_')}`
    return i18n.te(key) ? i18n.t(key) : value
  }
  return { action }
}
