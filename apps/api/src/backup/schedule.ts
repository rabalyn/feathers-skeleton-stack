import { CronExpressionParser } from 'cron-parser'

// The backup schedule is a runtime setting (ADR 0025): a five-field cron
// expression, read in local time like the worker's daily jobs (ADR 0024).
export const BACKUP_TIMEZONE = 'Europe/Berlin'

export const nextRun = (schedule: string, after: Date): Date =>
  CronExpressionParser.parse(schedule, { currentDate: after, tz: BACKUP_TIMEZONE }).next().toDate()
