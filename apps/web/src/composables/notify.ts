import { useQuasar } from 'quasar'
import { useI18n } from 'vue-i18n'
import type { ValidationError } from '@app/api/client'

// A schema's refusal names only the field (ValidationError, ADR 0005); the
// application's own 400s say what it refused.
type ErrorEntry = Partial<ValidationError['errors'][number]> & { message?: string }

interface ServiceError {
  code?: number
  message?: string
  // Feathers lifts `errors` out of the data it is given.
  errors?: ErrorEntry[]
  data?: { errors?: ErrorEntry[]; reason?: string }
}

// Service errors as the user should read them. 401 is the session store's
// business; 503 is a passing outage, never a reason to log anybody out
// (ADR 0010).
export const useNotify = () => {
  const $q = useQuasar()
  const { t } = useI18n()

  const success = (message: string) => $q.notify({ type: 'positive', message })

  const failure = (error: unknown) => {
    const { code, data, errors } = (error ?? {}) as ServiceError
    if (code === 401) return
    // Uploads (ADR 0020): too large for the limit or a quota, or a type
    // that is not accepted or not what the file really is.
    const tooLarge = { 'user-quota': 'errors.quota', 'total-quota': 'errors.totalQuota' }[data?.reason ?? ''] ?? 'errors.tooLarge'
    const message =
      code === 403
        ? t('errors.forbidden')
        : code === 413
          ? t(tooLarge)
          : code === 415
            ? t('errors.unsupportedType')
            : code === 503
              ? t('errors.unavailable')
              : t('errors.generic')
    // Validation details name the field, or say what the application refused.
    const details = code === 400 ? (errors ?? data?.errors ?? []).map((entry) => entry.message ?? entry.field).filter(Boolean) : []
    $q.notify({ type: 'negative', message, ...(details.length ? { caption: details.join(' · ') } : {}) })
  }

  return { success, failure }
}
