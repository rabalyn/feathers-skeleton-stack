import { readFileSync } from 'node:fs'
import { Type, getValidator, type Static, type TSchema } from '@feathersjs/typebox'
import { Ajv } from '@feathersjs/schema'

// Deployment configuration (ADR 0006). Each entry point loads only the fields
// it needs, so the migrate job does not demand the API's signing secret.
// Secrets are only ever read from `<NAME>_FILE` paths (ADR 0023); a secret
// passed as a plain environment variable is ignored, and there is no dotenv.

type Field = {
  schema: TSchema
  env: string
  secret?: boolean
  integer?: boolean
  default?: string
}

const port = Type.Integer({ minimum: 1, maximum: 65535 })

const fields = {
  publicOrigin: { schema: Type.String({ pattern: '^https://[^/]+$' }), env: 'PUBLIC_ORIGIN' },
  authSigningSecret: { schema: Type.String({ minLength: 32 }), env: 'AUTH_SIGNING_SECRET', secret: true },
  port: { schema: port, env: 'PORT', integer: true, default: '3030' },
  internalPort: { schema: port, env: 'INTERNAL_PORT', integer: true, default: '9090' },
  logLevel: {
    schema: Type.Union(['fatal', 'error', 'warn', 'info', 'debug', 'trace'].map((l) => Type.Literal(l))),
    env: 'LOG_LEVEL',
    default: 'info'
  },
  databaseHost: { schema: Type.String({ minLength: 1 }), env: 'DATABASE_HOST' },
  databasePort: { schema: port, env: 'DATABASE_PORT', integer: true },
  databaseName: { schema: Type.String({ pattern: '^[a-z_][a-z0-9_]*$' }), env: 'DATABASE_NAME' },
  databaseUser: { schema: Type.String({ minLength: 1 }), env: 'DATABASE_USER' },
  databasePassword: { schema: Type.String({ minLength: 16 }), env: 'DATABASE_PASSWORD', secret: true },
  // CA root that the database server certificate must chain to (ADR 0004).
  // A path, not a secret.
  databaseCaFile: { schema: Type.String({ minLength: 1 }), env: 'DATABASE_CA_FILE' },
  // SAML (ADR 0008). Certificates are not secret but are delivered the same
  // way as the key, as files rendered by the api-agent.
  samlSpPrivateKey: {
    schema: Type.String({ pattern: '-----BEGIN (RSA )?PRIVATE KEY-----' }),
    env: 'SAML_SP_PRIVATE_KEY',
    secret: true
  },
  samlSpCertificate: {
    schema: Type.String({ pattern: '-----BEGIN CERTIFICATE-----' }),
    env: 'SAML_SP_CERTIFICATE',
    secret: true
  },
  samlIdpCertificate: {
    schema: Type.String({ pattern: '-----BEGIN CERTIFICATE-----' }),
    env: 'SAML_IDP_CERTIFICATE',
    secret: true
  },
  samlIdpEntityId: { schema: Type.String({ minLength: 1 }), env: 'SAML_IDP_ENTITY_ID' },
  samlIdpSsoUrl: { schema: Type.String({ pattern: '^https://' }), env: 'SAML_IDP_SSO_URL' },
  samlIdpSloUrl: { schema: Type.String({ pattern: '^https://' }), env: 'SAML_IDP_SLO_URL' },
  databasePoolMax: {
    schema: Type.Integer({ minimum: 1, maximum: 50 }),
    env: 'DATABASE_POOL_MAX',
    integer: true,
    default: '10'
  }
} satisfies Record<string, Field>

type Fields = typeof fields
export type ConfigKey = keyof Fields
export type Config = { [K in ConfigKey]: Static<Fields[K]['schema']> }

export const DATABASE_KEYS = [
  'databaseHost',
  'databasePort',
  'databaseName',
  'databaseUser',
  'databasePassword',
  'databaseCaFile',
  'databasePoolMax'
] as const satisfies readonly ConfigKey[]

export const SAML_KEYS = [
  'samlSpPrivateKey',
  'samlSpCertificate',
  'samlIdpCertificate',
  'samlIdpEntityId',
  'samlIdpSsoUrl',
  'samlIdpSloUrl'
] as const satisfies readonly ConfigKey[]

export const API_KEYS = [
  'publicOrigin',
  'authSigningSecret',
  ...SAML_KEYS,
  'port',
  'internalPort',
  'logLevel',
  ...DATABASE_KEYS
] as const satisfies readonly ConfigKey[]

export const MIGRATE_KEYS = ['logLevel', ...DATABASE_KEYS] as const satisfies readonly ConfigKey[]

export class ConfigError extends Error {}

const readSecretFile = (name: string, path: string): string => {
  try {
    // Only a single trailing newline is stripped, so PEM content keeps its shape.
    return readFileSync(path, 'utf8').replace(/\r?\n$/, '')
  } catch (error) {
    throw new ConfigError(`${name}_FILE: cannot read ${path}: ${(error as Error).message}`)
  }
}

const envName = (key: ConfigKey) => {
  const field: Field = fields[key]
  return field.secret ? `${field.env}_FILE` : field.env
}

type AjvIssue = { instancePath: string; message?: string; params: { missingProperty?: string } }

export const loadConfig = async <K extends ConfigKey>(
  keys: readonly K[],
  env: NodeJS.ProcessEnv = process.env
): Promise<Pick<Config, K>> => {
  const properties: Record<string, TSchema> = {}
  const raw: Record<string, unknown> = {}

  for (const key of keys) {
    const field: Field = fields[key]
    properties[key] = field.schema

    let value: string | undefined
    if (field.secret) {
      const path = env[`${field.env}_FILE`]
      value = path === undefined ? undefined : readSecretFile(field.env, path)
    } else {
      value = env[field.env] ?? field.default
    }

    if (value === undefined) continue
    raw[key] = field.integer && /^\d+$/.test(value) ? Number(value) : value
  }

  const validate = getValidator(
    Type.Object(properties, { additionalProperties: false }),
    new Ajv({ allErrors: true })
  )

  try {
    return (await validate(raw)) as Pick<Config, K>
  } catch (error) {
    const issues = (error as { errors?: AjvIssue[] }).errors ?? []
    const lines = issues.map((issue) => {
      const key = (issue.params.missingProperty ?? issue.instancePath.slice(1)) as ConfigKey
      return `${key in fields ? envName(key) : 'config'}: ${issue.message ?? 'invalid'}`
    })
    throw new ConfigError(`Invalid configuration:\n  ${lines.join('\n  ')}`)
  }
}

export type ApiConfig = Pick<Config, (typeof API_KEYS)[number]>
export type DatabaseConfig = Pick<Config, (typeof DATABASE_KEYS)[number]>
