import { useQuasar } from 'quasar'
import { useI18n } from 'vue-i18n'

interface ServiceError {
  code?: number
  message?: string
  data?: { errors?: { message?: string }[] }
}

// Service errors as the user should read them. 401 is the session store's
// business; 503 is a passing outage, never a reason to log anybody out
// (ADR 0010).
export const useNotify = () => {
  const $q = useQuasar()
  const { t } = useI18n()

  const success = (message: string) => $q.notify({ type: 'positive', message })

  const failure = (error: unknown) => {
    const { code, data } = (error ?? {}) as ServiceError
    if (code === 401) return
    const message =
      code === 403 ? t('errors.forbidden') : code === 503 ? t('errors.unavailable') : t('errors.generic')
    // Validation details come from the server's schemas and name the field.
    const details = code === 400 ? (data?.errors ?? []).map((entry) => entry.message).filter(Boolean) : []
    $q.notify({ type: 'negative', message, ...(details.length ? { caption: details.join(' · ') } : {}) })
  }

  return { success, failure }
}
