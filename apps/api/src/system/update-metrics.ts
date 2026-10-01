import type { Knex } from 'knex'
import { Gauge, type Registry } from 'prom-client'
import { COMPONENT_UPDATES_TABLE } from './update-check.js'

// The update check's results as metrics (ADR 0032), read from the table at
// scrape time, so every worker process reports the same and a restart loses
// nothing. Grafana alerts on them (ADR 0022): a patch available for 7 days,
// an end of life within 90 days, a check failing for 3 days.

interface Row {
  component: string
  patchSince: Date | null
  minorSince: Date | null
  majorSince: Date | null
  eol: string | Date | null
  failingSince: Date | null
}

const seconds = (value: Date | string) => new Date(value).getTime() / 1000

export const observeUpdates = (registry: Registry, knex: Knex) => {
  let rows: Promise<Row[]> | undefined
  // The three gauges are collected one after another in one scrape; one
  // query serves them all.
  const read = () => {
    rows ??= knex<Row>(COMPONENT_UPDATES_TABLE)
      .select('component', 'patchSince', 'minorSince', 'majorSince', 'eol', 'failingSince')
      .finally(() => setImmediate(() => (rows = undefined)))
    return rows
  }

  new Gauge({
    name: 'stack_update_available_since_timestamp_seconds',
    help: 'Since when a newer version of the kind has been available for a component',
    labelNames: ['component', 'kind'],
    registers: [registry],
    async collect() {
      this.reset()
      for (const row of await read()) {
        for (const kind of ['patch', 'minor', 'major'] as const) {
          const since = row[`${kind}Since`]
          if (since) this.set({ component: row.component, kind }, seconds(since))
        }
      }
    }
  })
  new Gauge({
    name: 'stack_eol_timestamp_seconds',
    help: 'End of life of the release line a component runs, where a date is known',
    labelNames: ['component'],
    registers: [registry],
    async collect() {
      this.reset()
      for (const row of await read()) if (row.eol) this.set({ component: row.component }, seconds(row.eol))
    }
  })
  new Gauge({
    name: 'stack_update_check_failing_since_timestamp_seconds',
    help: 'Since when the update check has failed for a component without a success in between',
    labelNames: ['component'],
    registers: [registry],
    async collect() {
      this.reset()
      for (const row of await read()) {
        if (row.failingSince) this.set({ component: row.component }, seconds(row.failingSince))
      }
    }
  })
}
