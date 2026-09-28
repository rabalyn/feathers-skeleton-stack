import { Type, type Static, type TSchema } from '@feathersjs/typebox'

// Runtime settings (ADR 0025): the one registry of every key, its schema and
// its default. The migrate job seeds every key it does not find; the API, the
// worker and the backup service refuse to start without the keys they need.
//
// Durations are whole seconds or days as the key name says, sizes are bytes.

const days = Type.Integer({ minimum: 1, maximum: 3650 })
const seconds = (maximum: number) => Type.Integer({ minimum: 1, maximum })
const bytes = Type.Integer({ minimum: 1 })

const HOUR = 60 * 60
const DAY = 24 * HOUR
const MIB = 1024 * 1024

const define = <S extends TSchema>(schema: S, defaultValue: Static<S>) => ({ schema, default: defaultValue })

export const SETTINGS = {
  auditRetentionDays: define(days, 90),
  // Counted from the expiry of the session's token family.
  expiredSessionRetentionDays: define(days, 30),
  exportRetentionDays: define(days, 7),
  objectPurgeDelayDays: define(days, 32),
  refreshGraceSeconds: define(seconds(300), 10),
  sessionIdleSeconds: define(seconds(30 * DAY), 8 * HOUR),
  sessionAbsoluteSeconds: define(seconds(90 * DAY), 7 * DAY),
  // Below the Nginx ceiling of 10 MiB, with room for multipart framing.
  maxUploadBytes: define(bytes, 8 * MIB),
  userQuotaBytes: define(bytes, 100 * 1000 * 1000),
  totalQuotaBytes: define(bytes, 5 * 1000 * 1000 * 1000),
  // Five-field cron expression, interpreted by the backup service.
  backupSchedule: define(Type.String({ pattern: '^\\S+( \\S+){4}$', maxLength: 128 }), '0 3 * * *'),
  backupRetentionDailySnapshots: define(Type.Integer({ minimum: 1, maximum: 3650 }), 31),
  // Fail-closed rate limits (ADR 0010), attempts per client IP and minute.
  // Generous, because a university network puts many people behind few
  // addresses; tightened by an admin during an incident.
  rateLimitSamlLoginPerMinute: define(Type.Integer({ minimum: 1, maximum: 100_000 }), 60),
  rateLimitSamlAcsPerMinute: define(Type.Integer({ minimum: 1, maximum: 100_000 }), 60),
  rateLimitRefreshPerMinute: define(Type.Integer({ minimum: 1, maximum: 100_000 }), 600),
  // Per account and client IP; one person, so not generous.
  rateLimitPasswordLoginPerMinute: define(Type.Integer({ minimum: 1, maximum: 100_000 }), 5),
  // Mail sending (ADR 0027): at most this many mails per window, across all
  // worker processes; the rate the previous applications sent at.
  mailSendLimitCount: define(Type.Integer({ minimum: 1, maximum: 10_000 }), 10),
  mailSendLimitWindowSeconds: define(seconds(DAY), 300),
  featureFlags: define(Type.Record(Type.String({ pattern: '^[a-zA-Z][a-zA-Z0-9]*$' }), Type.Boolean()), {}),
  maintenanceMode: define(Type.Boolean(), false)
}

export type SettingKey = keyof typeof SETTINGS
export type SettingValues = { [K in SettingKey]: Static<(typeof SETTINGS)[K]['schema']> }

export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[]

export const isSettingKey = (key: unknown): key is SettingKey =>
  typeof key === 'string' && Object.prototype.hasOwnProperty.call(SETTINGS, key)

// What each consumer refuses to start without (ADR 0025).
export const API_SETTINGS = [
  'refreshGraceSeconds',
  'sessionIdleSeconds',
  'sessionAbsoluteSeconds',
  'maxUploadBytes',
  'userQuotaBytes',
  'totalQuotaBytes',
  'rateLimitSamlLoginPerMinute',
  'rateLimitSamlAcsPerMinute',
  'rateLimitRefreshPerMinute',
  'rateLimitPasswordLoginPerMinute',
  'featureFlags',
  'maintenanceMode'
] as const satisfies readonly SettingKey[]

export const WORKER_SETTINGS = [
  'auditRetentionDays',
  'expiredSessionRetentionDays',
  'objectPurgeDelayDays',
  'mailSendLimitCount',
  'mailSendLimitWindowSeconds'
] as const satisfies readonly SettingKey[]

export const BACKUP_SETTINGS = ['backupSchedule', 'backupRetentionDailySnapshots'] as const satisfies readonly SettingKey[]

// Rules that span two settings, or a setting and deployment configuration.
// Checked on every write against the settings as they would be afterwards;
// each returns a message when violated.
export interface CrossSettingContext {
  values: Partial<SettingValues>
  bodySizeCeilingBytes: number
}

export const CROSS_SETTING_RULES: ReadonlyArray<(context: CrossSettingContext) => string | undefined> = [
  ({ values: { objectPurgeDelayDays, backupRetentionDailySnapshots } }) =>
    objectPurgeDelayDays !== undefined &&
    backupRetentionDailySnapshots !== undefined &&
    objectPurgeDelayDays <= backupRetentionDailySnapshots
      ? 'objectPurgeDelayDays must exceed backupRetentionDailySnapshots (ADR 0020)'
      : undefined,
  ({ values: { maxUploadBytes }, bodySizeCeilingBytes }) =>
    maxUploadBytes !== undefined && maxUploadBytes >= bodySizeCeilingBytes
      ? `maxUploadBytes must stay below the Nginx body size ceiling of ${bodySizeCeilingBytes} bytes`
      : undefined,
  ({ values: { sessionIdleSeconds, sessionAbsoluteSeconds } }) =>
    sessionIdleSeconds !== undefined && sessionAbsoluteSeconds !== undefined && sessionIdleSeconds > sessionAbsoluteSeconds
      ? 'sessionIdleSeconds must not exceed sessionAbsoluteSeconds'
      : undefined
]
