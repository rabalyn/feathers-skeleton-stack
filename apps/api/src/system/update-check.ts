import type { Knex } from 'knex'
import type { Logger } from 'pino'
import { COMPONENTS, inventoryById, type Component } from './components.js'
import type { Labels } from './prometheus.js'
import type { Cycle, UpdateSources } from './update-sources.js'
import { findUpdates, lineOf, parseTag, type Updates } from './versions.js'

// The daily update check (ADR 0032): per component, the newest patch, minor
// and major the registry lists beside the declared tag, and the end of life
// of the running line where endoflife.date knows it. One failing component
// keeps its last results and records why; the others go on.

// The table component_updates, named as the camelCase Knex instances name it.
export const COMPONENT_UPDATES_TABLE = 'componentUpdates'

// The host's OS, as node_exporter's os-release labels name it, to the
// endoflife.date product.
const OS_PRODUCTS: Record<string, string> = {
  debian: 'debian',
  ubuntu: 'ubuntu',
  rhel: 'rhel',
  almalinux: 'almalinux',
  rocky: 'rocky-linux',
  centos: 'centos-stream',
  fedora: 'fedora',
  sles: 'sles',
  'opensuse-leap': 'opensuse'
}

interface Row {
  component: string
  compared: string | null
  latestPatch: string | null
  latestMinor: string | null
  latestMajor: string | null
  patchSince: Date | null
  minorSince: Date | null
  majorSince: Date | null
  eolLine: string | null
  eol: string | null
  checkedAt: Date | null
  attemptedAt: Date
  error: string | null
  failingSince: Date | null
}

interface Result {
  compared: string | null
  updates: Updates
  eolLine: string | null
  eol: string | null
}

export interface UpdateCheckInput {
  knex: Knex
  sources: UpdateSources
  // node_exporter's os-release labels, or null when Prometheus has none.
  hostOs: () => Promise<Labels | null>
  logger: Logger
  now?: () => Date
}

const NONE: Updates = { patch: null, minor: null, major: null }

// The running line's end of life: a date, null while none is announced,
// or the day of the check when the line has ended without a date.
const eolOf = (cycles: Cycle[], candidates: string[], today: string) => {
  for (const line of candidates) {
    const cycle = cycles.find((entry) => entry.cycle === line)
    if (!cycle) continue
    if (typeof cycle.eol === 'string') return { eolLine: line, eol: cycle.eol }
    return { eolLine: line, eol: cycle.eol ? today : null }
  }
  return { eolLine: null, eol: null }
}

const checkComponent = async (component: Component, input: UpdateCheckInput, today: string): Promise<Result> => {
  if (component.id === 'host') {
    const os = await input.hostOs()
    const versionId = os?.version_id ?? null
    const product = os?.id ? OS_PRODUCTS[os.id] : undefined
    if (!versionId || !product) return { compared: versionId, updates: NONE, eolLine: null, eol: null }
    const cycles = await input.sources.cycles(product)
    return { compared: versionId, updates: NONE, ...eolOf(cycles, [versionId, versionId.split('.')[0]!], today) }
  }
  const declared = inventoryById.get(component.id)
  if (!declared?.image || !declared.version) return { compared: null, updates: NONE, eolLine: null, eol: null }
  const [tags, cycles] = await Promise.all([
    input.sources.tags(declared.image),
    component.eol ? input.sources.cycles(component.eol) : Promise.resolve(null)
  ])
  const updates = findUpdates(declared.version, tags, component.rule)
  const line = lineOf(parseTag(declared.version, component.rule)!, component.rule)
  return { compared: declared.version, updates, ...(cycles ? eolOf(cycles, [line], today) : { eolLine: null, eol: null }) }
}

// Since when an update of one kind has been available: kept while some update
// of that kind stays available for the same compared version, so a patch
// that is replaced by a newer patch has still waited since the first.
const LATEST = { patch: 'latestPatch', minor: 'latestMinor', major: 'latestMajor' } as const
const SINCE = { patch: 'patchSince', minor: 'minorSince', major: 'majorSince' } as const

const since = (latest: string | null, previous: Row | undefined, kind: keyof typeof LATEST, compared: string | null, now: Date) => {
  if (!latest) return null
  if (previous && previous.compared === compared && previous[LATEST[kind]]) return previous[SINCE[kind]] ?? now
  return now
}

export const runUpdateCheck = async (input: UpdateCheckInput): Promise<{ checked: number; failed: number }> => {
  const now = (input.now ?? (() => new Date()))()
  const today = now.toISOString().slice(0, 10)
  const previous = new Map(
    (await input.knex<Row>(COMPONENT_UPDATES_TABLE).select('*')).map((row) => [row.component, row] as const)
  )
  let checked = 0
  let failed = 0
  for (const component of COMPONENTS) {
    const old = previous.get(component.id)
    try {
      const result = await checkComponent(component, input, today)
      const row: Row = {
        component: component.id,
        compared: result.compared,
        latestPatch: result.updates.patch,
        latestMinor: result.updates.minor,
        latestMajor: result.updates.major,
        patchSince: since(result.updates.patch, old, 'patch', result.compared, now),
        minorSince: since(result.updates.minor, old, 'minor', result.compared, now),
        majorSince: since(result.updates.major, old, 'major', result.compared, now),
        eolLine: result.eolLine,
        eol: result.eol,
        checkedAt: now,
        attemptedAt: now,
        error: null,
        failingSince: null
      }
      await input.knex(COMPONENT_UPDATES_TABLE).insert(row).onConflict('component').merge()
      checked++
    } catch (error) {
      const message = (error as Error).message.slice(0, 500)
      input.logger.warn({ component: component.id, err: { message } }, 'update check failed for a component')
      await input
        .knex(COMPONENT_UPDATES_TABLE)
        .insert({ component: component.id, attemptedAt: now, error: message, failingSince: old?.failingSince ?? now })
        .onConflict('component')
        .merge(['attemptedAt', 'error', 'failingSince'])
      failed++
    }
  }
  return { checked, failed }
}
