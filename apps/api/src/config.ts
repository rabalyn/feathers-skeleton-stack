import { readFileSync } from 'node:fs'
import { Type, getValidator, type Static } from '@feathersjs/typebox'
import { Ajv } from '@feathersjs/schema'

// Deployment configuration (ADR 0006). Secrets are only ever read from
// `<NAME>_FILE` paths (ADR 0023); a secret passed as a plain environment
// variable is ignored, and there is no dotenv.

const port = Type.Integer({ minimum: 1, maximum: 65535 })

export const configSchema = Type.Object(
  {
    publicOrigin: Type.String({ pattern: '^https://[^/]+$' }),
    port,
    internalPort: port,
    logLevel: Type.Union([
      Type.Literal('fatal'),
      Type.Literal('error'),
      Type.Literal('warn'),
      Type.Literal('info'),
      Type.Literal('debug'),
      Type.Literal('trace')
    ])
  },
  { $id: 'Config', additionalProperties: false }
)

export type Config = Static<typeof configSchema>

type Source = { env: string; secret?: boolean; type?: 'string' | 'integer'; default?: string }

const sources: Record<keyof Config, Source> = {
  publicOrigin: { env: 'PUBLIC_ORIGIN' },
  port: { env: 'PORT', type: 'integer', default: '3030' },
  internalPort: { env: 'INTERNAL_PORT', type: 'integer', default: '9090' },
  logLevel: { env: 'LOG_LEVEL', default: 'info' }
}

export class ConfigError extends Error {}

const readSecretFile = (name: string, path: string): string => {
  try {
    // Only a single trailing newline is stripped, so PEM content keeps its shape.
    return readFileSync(path, 'utf8').replace(/\r?\n$/, '')
  } catch (error) {
    throw new ConfigError(`${name}_FILE: cannot read ${path}: ${(error as Error).message}`)
  }
}

const validate = getValidator(configSchema, new Ajv({ allErrors: true }))

export const loadConfig = async (env: NodeJS.ProcessEnv = process.env): Promise<Config> => {
  const raw: Record<string, unknown> = {}

  for (const [key, source] of Object.entries(sources) as [keyof Config, Source][]) {
    let value: string | undefined

    if (source.secret) {
      const path = env[`${source.env}_FILE`]
      value = path === undefined ? undefined : readSecretFile(source.env, path)
    } else {
      value = env[source.env] ?? source.default
    }

    if (value === undefined) continue
    raw[key] = source.type === 'integer' && /^\d+$/.test(value) ? Number(value) : value
  }

  try {
    return (await validate(raw)) as Config
  } catch (error) {
    type AjvIssue = { instancePath: string; message?: string; params: { missingProperty?: string } }
    const issues = (error as { errors?: AjvIssue[] }).errors ?? []
    const lines = issues.map((issue) => {
      const key = (issue.params.missingProperty ?? issue.instancePath.slice(1)) as keyof Config
      const source = sources[key]
      const name = source ? (source.secret ? `${source.env}_FILE` : source.env) : 'config'
      return `${name}: ${issue.message ?? 'invalid'}`
    })
    throw new ConfigError(`Invalid configuration:\n  ${lines.join('\n  ')}`)
  }
}
