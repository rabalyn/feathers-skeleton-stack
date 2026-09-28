import { useI18n } from 'vue-i18n'

// What the mail pages share (ADR 0027): names of kinds and their
// parameters, the sending time, the paths a template may use, and the
// template check's answer as the admin should read it.

interface JsonSchema {
  type?: string
  format?: string
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
  anyOf?: JsonSchema[]
  const?: unknown
  default?: unknown
  minimum?: number
  maximum?: number
}

export type { JsonSchema }

// Every path a template may print or loop over, e.g. `documents[].title`.
export const variablePaths = (schema: JsonSchema, prefix = ''): string[] => {
  if (schema.type === 'object' && schema.properties) {
    return Object.entries(schema.properties).flatMap(([name, child]) => variablePaths(child, prefix ? `${prefix}.${name}` : name))
  }
  if (schema.type === 'array' && schema.items) return [prefix, ...variablePaths(schema.items, `${prefix}[]`).filter((path) => path !== `${prefix}[]`)]
  return [prefix]
}

interface TemplateProblem {
  part?: string
  line?: number | null
  message?: string
}

export const useMail = () => {
  const i18n = useI18n()
  const { t } = i18n
  const te = (key: string) => i18n.te(key)

  // Kinds and parameters are declared in code; their names come from the
  // catalogues where a product added them, otherwise the key is shown.
  const kindLabel = (key: string) => (te(`mail.kinds.${key}`) ? t(`mail.kinds.${key}`) : key)
  const paramLabel = (kind: string, name: string) =>
    te(`mail.params.${kind}.${name}`) ? t(`mail.params.${kind}.${name}`) : name

  const duration = (seconds: number) => {
    const minutes = Math.ceil(seconds / 60)
    if (minutes < 60) return t('mail.minutes', { n: minutes })
    return t('mail.hours', { h: Math.floor(minutes / 60), m: minutes % 60 })
  }

  // The server names the part and line of what failed the check.
  const problems = (error: unknown): string[] => {
    const errors = ((error as { errors?: TemplateProblem[] } | null)?.errors ?? []).filter((each) => each.message)
    return errors.map((each) => {
      const part = each.part === 'subject' || each.part === 'body' ? t(`mail.parts.${each.part}`) : (each.part ?? '')
      return each.line
        ? t('mail.refusedAt', { part, line: each.line, message: each.message })
        : t('mail.refusedPart', { part, message: each.message })
    })
  }

  return { kindLabel, paramLabel, duration, problems }
}
