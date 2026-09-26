import { describe, expect, it } from 'vitest'
import { fileName, objectKey } from '../../src/backup/mirror.js'
import { summary } from '../../src/backup/restic.js'
import { nextRun } from '../../src/backup/schedule.js'

// ADR 0017: the pieces of the backup service that need no restic, target
// or stack; the whole path is exercised by scripts/backup-test.sh.

describe('backup schedule', () => {
  it('reads the cron expression in local time, across daylight saving time', () => {
    // 03:00 in Berlin is 01:00 UTC in summer and 02:00 UTC in winter.
    expect(nextRun('0 3 * * *', new Date('2026-09-26T12:00:00Z')).toISOString()).toBe('2026-09-27T01:00:00.000Z')
    expect(nextRun('0 3 * * *', new Date('2026-12-01T12:00:00Z')).toISOString()).toBe('2026-12-02T02:00:00.000Z')
  })

  it('refuses what is not a cron expression', () => {
    expect(() => nextRun('99 * * * *', new Date())).toThrow()
  })
})

describe('bucket mirror file names', () => {
  it('keeps a UUID key as it is', () => {
    const id = crypto.randomUUID()
    expect(fileName(id)).toBe(id)
  })

  it('never names a path, a parent or a dot file, and maps back', () => {
    for (const key of ['a/b', '../x', '.partial-y', '..', 'ü ß']) {
      const name = fileName(key)
      expect(name).not.toMatch(/[/]|^\./)
      expect(objectKey(name)).toBe(key)
    }
  })
})

describe('restic summary', () => {
  it('takes the last JSON line', () => {
    expect(summary('{"message_type":"status"}\n{"message_type":"summary","snapshot_id":"abc"}\n')).toMatchObject({ snapshot_id: 'abc' })
  })

  it('is empty when there is none', () => {
    expect(summary('')).toEqual({})
  })
})
