import type { SettingKey } from '@app/api/client'
import { describe, expect, it } from 'vitest'
import de from '@/i18n/de.json'
import en from '@/i18n/en.json'

// ADR 0025: every registered runtime setting is described in every locale,
// or the settings page would show a key without its explanation. The
// registry itself is server code; this record is checked against its keys
// by the typechecker, so a key added or removed there fails here.
const KEYS: Record<SettingKey, true> = {
  auditRetentionDays: true,
  expiredSessionRetentionDays: true,
  exportRetentionDays: true,
  objectPurgeDelayDays: true,
  refreshGraceSeconds: true,
  sessionIdleSeconds: true,
  sessionAbsoluteSeconds: true,
  maxUploadBytes: true,
  userQuotaBytes: true,
  totalQuotaBytes: true,
  backupSchedule: true,
  backupRetentionDailySnapshots: true,
  rateLimitSamlLoginPerMinute: true,
  rateLimitSamlAcsPerMinute: true,
  rateLimitRefreshPerMinute: true,
  rateLimitPasswordLoginPerMinute: true,
  rateLimitUploadsPerMinute: true,
  rateLimitDataExportsPerMinute: true,
  rateLimitMailCampaignsPerMinute: true,
  rateLimitUpdateChecksPerMinute: true,
  rateLimitDirectorySearchPerMinute: true,
  rateLimitSiteLookupPerMinute: true,
  mailSendLimitCount: true,
  mailSendLimitWindowSeconds: true,
  mailDeliveryRetentionDays: true,
  featureFlags: true,
  maintenanceMode: true,
  viewAsMinutes: true
}
const SETTING_KEYS = Object.keys(KEYS)

describe.each([
  ['de', de],
  ['en', en]
])('%s', (_locale, messages) => {
  const { help } = messages.settings as { help: Record<string, string> }

  it.each(SETTING_KEYS)('describes %s', (key) => {
    expect(help[key]).toBeTruthy()
  })

  it('has nothing for a setting the registry no longer declares', () => {
    expect(Object.keys(help).sort()).toEqual([...SETTING_KEYS].sort())
  })
})
