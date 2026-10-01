import { pino } from 'pino'
import { Registry } from '@prometheus-io/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Application } from '../../src/app.js'
import { INVENTORY } from '../../src/system/components.js'
import { SourceError } from '../../src/system/http.js'
import type { Labels } from '../../src/system/prometheus.js'
import { COMPONENT_UPDATES_TABLE, runUpdateCheck } from '../../src/system/update-check.js'
import { observeUpdates } from '../../src/system/update-metrics.js'
import type { Cycle, UpdateSources } from '../../src/system/update-sources.js'
import { createTestApp } from '../support/app.js'

// ADR 0032: the daily update check stores, per component, the newest patch,
// minor and major and the running line's end of life; keeps since when each
// has been available; and keeps its last results when a source fails. The
// sources are faked: tests never reach the internet.

let app: Application
const knex = () => app.get('knex')
const logger = pino({ level: 'silent' })

beforeAll(async () => {
  ;({ app } = await createTestApp())
})

afterAll(async () => {
  await app.teardown()
})

beforeEach(async () => {
  await knex()(COMPONENT_UPDATES_TABLE).delete()
})

const declared = (id: string) => INVENTORY.find((entry) => entry.id === id)!
const POSTGRES = declared('postgresql')
const DAY_MS = 24 * 3600 * 1000

// Every image lists only its declared tag, unless a test says otherwise.
const fakeSources = (
  tags: Record<string, string[]> = {},
  cycles: Record<string, Cycle[]> = {},
  failing: string[] = []
): UpdateSources => ({
  async tags(image) {
    if (failing.includes(image)) throw new SourceError(`${image}: no route`)
    return tags[image] ?? [INVENTORY.find((entry) => entry.image === image)!.version!]
  },
  async cycles(product) {
    return cycles[product] ?? []
  }
})

const debian13: Labels = { id: 'debian', version_id: '13', pretty_name: 'Debian GNU/Linux 13 (trixie)' }

const run = (sources: UpdateSources, now: Date, hostOs: Labels | null = debian13) =>
  runUpdateCheck({ knex: knex(), sources, hostOs: async () => hostOs, logger, now: () => now })

const row = (component: string) => knex()(COMPONENT_UPDATES_TABLE).where({ component }).first()

describe('update check', () => {
  it('stores the newest patch, minor and major and the end of life of the running line', async () => {
    const now = new Date('2026-10-01T03:30:00Z')
    const result = await run(
      fakeSources(
        { [POSTGRES.image!]: [POSTGRES.version!, '18.7-alpine', '18.7-bookworm', '19.1-alpine', '19rc1-alpine'] },
        { postgresql: [{ cycle: '18', eol: '2030-11-14' }], debian: [{ cycle: '13', eol: '2030-06-30' }] }
      ),
      now
    )
    expect(result.failed).toBe(0)
    expect(await row('postgresql')).toMatchObject({
      compared: POSTGRES.version,
      latestPatch: '18.7-alpine',
      latestMinor: null,
      latestMajor: '19.1-alpine',
      patchSince: now,
      majorSince: now,
      eolLine: '18',
      checkedAt: now,
      error: null,
      failingSince: null
    })
    expect((await row('postgresql')).eol).toEqual(new Date('2030-11-14T00:00:00'))
    // Current, and a line whose end of life endoflife.date doesn't know.
    expect(await row('valkey')).toMatchObject({ latestPatch: null, latestMinor: null, latestMajor: null, eolLine: null, eol: null })
    // No image: nothing to compare.
    expect(await row('pgbouncer')).toMatchObject({ compared: null, latestPatch: null })
    expect(await row('host')).toMatchObject({ compared: '13', eolLine: '13' })
  })

  it('keeps since when an update has been available, across runs and a newer patch', async () => {
    const first = new Date('2026-10-01T03:30:00Z')
    await run(fakeSources({ [POSTGRES.image!]: [POSTGRES.version!, '18.7-alpine'] }), first)
    const second = new Date(first.getTime() + 3 * DAY_MS)
    await run(fakeSources({ [POSTGRES.image!]: [POSTGRES.version!, '18.7-alpine', '18.8-alpine'] }), second)
    expect(await row('postgresql')).toMatchObject({ latestPatch: '18.8-alpine', patchSince: first, checkedAt: second })

    // Deployed: nothing newer any more.
    const third = new Date(second.getTime() + DAY_MS)
    await run(fakeSources(), third)
    expect(await row('postgresql')).toMatchObject({ latestPatch: null, patchSince: null })
  })

  it('keeps the last results of a component whose source fails, and since when it fails', async () => {
    const first = new Date('2026-10-01T03:30:00Z')
    await run(fakeSources({ [POSTGRES.image!]: [POSTGRES.version!, '18.7-alpine'] }), first)
    const second = new Date(first.getTime() + DAY_MS)
    const result = await run(fakeSources({}, {}, [POSTGRES.image!]), second)
    expect(result.failed).toBe(1)
    expect(await row('postgresql')).toMatchObject({
      latestPatch: '18.7-alpine',
      checkedAt: first,
      attemptedAt: second,
      error: `${POSTGRES.image}: no route`,
      failingSince: second
    })
    // The others went on.
    expect(await row('valkey')).toMatchObject({ checkedAt: second, error: null })

    const third = new Date(second.getTime() + DAY_MS)
    await run(fakeSources({}, {}, [POSTGRES.image!]), third)
    expect(await row('postgresql')).toMatchObject({ failingSince: second, attemptedAt: third })

    const fourth = new Date(third.getTime() + DAY_MS)
    await run(fakeSources(), fourth)
    expect(await row('postgresql')).toMatchObject({ error: null, failingSince: null, checkedAt: fourth })
  })

  it('knows no end of life for an OS endoflife.date does not cover', async () => {
    await run(fakeSources(), new Date('2026-10-01T03:30:00Z'), { id: 'cachyos', version_id: '', pretty_name: 'CachyOS' })
    expect(await row('host')).toMatchObject({ eolLine: null, eol: null, error: null })
  })

  it('exports since when updates are available, the end of life and failures as metrics', async () => {
    const now = new Date('2026-10-01T03:30:00Z')
    await run(
      fakeSources({ [POSTGRES.image!]: [POSTGRES.version!, '18.7-alpine'] }, { postgresql: [{ cycle: '18', eol: '2030-11-14' }] }, [
        declared('valkey').image!
      ]),
      now
    )
    const registry = new Registry()
    observeUpdates(registry, knex())
    const text = await registry.metrics()
    expect(text).toContain(`stack_update_available_since_timestamp_seconds{component="postgresql",kind="patch"} ${now.getTime() / 1000}`)
    expect(text).toMatch(/stack_eol_timestamp_seconds\{component="postgresql"\} \d+/)
    expect(text).toContain(`stack_update_check_failing_since_timestamp_seconds{component="valkey"} ${now.getTime() / 1000}`)
  })
})
