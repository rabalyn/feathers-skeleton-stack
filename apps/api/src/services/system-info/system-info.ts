import { BadRequest, Conflict, Unavailable } from '@feathersjs/errors'
import type { Params } from '@feathersjs/feathers'
import { Queue, QueueEvents } from 'bullmq'
import type { Application } from '../../app.js'
import { publishNothing, publishTo, subjectChannel } from '../../channels.js'
import {
  MAINTENANCE_QUEUE,
  UPDATE_CHECK,
  UPDATE_CHECK_ASKED_OPTIONS,
  isUpdateCheckJob,
  queueConnection,
  updateCheckRunning
} from '../../jobs/queues.js'
import { Netbox } from '../../netbox.js'
import { COMPONENTS, inventoryById, type Component } from '../../system/components.js'
import { Prometheus, type Labels } from '../../system/prometheus.js'
import { COMPONENT_UPDATES_TABLE } from '../../system/update-check.js'
import { parseTag } from '../../system/versions.js'

// The system-info page (ADR 0032), under `system-info.read` (ADR 0011): per
// component what this build pins, what runs now, and what the daily update
// check found. Read-only. The running versions are asked for on every read,
// each source with a short timeout; one that fails leaves its rows without a
// running version and says why.
//
// An admin may also ask for a check now (`update-checks`, ADR 0032). While
// somebody who reads the page is connected, the api follows the check's
// jobs on the maintenance queue and publishes a `check` event to the
// subject channel whenever one starts or ends (ADR 0012).

export const SYSTEM_INFO_PATH = 'system-info'
export const SYSTEM_INFO_REPORT_EXTERNAL_METHODS = ['find'] as const
export const SYSTEM_INFO_CHECK_EVENT = 'check'

export interface SystemInfoCheckStatus {
  running: boolean
}

// The queue events that start or end a check's job.
const CHECK_CHANGES = ['added', 'active', 'completed', 'failed', 'removed'] as const

export interface SystemComponent {
  id: string
  name: string
  image: string | null
  declared: string | null
  running: string | null
  // Why there is no running version: nothing reports it, or the source failed.
  runningMissing: 'not-reported' | 'source-failed' | null
  // The declared and running versions name different releases.
  drift: boolean
  latestPatch: string | null
  latestMinor: string | null
  latestMajor: string | null
  patchSince: string | null
  eolLine: string | null
  eol: string | null
  checkedAt: string | null
  error: string | null
}

export interface SystemInfoReport {
  // The commit the api image was built from.
  app: { commit: string | null; commitTime: string | null; dirty: boolean }
  updateCheck: 'on' | 'off'
  // A check runs or waits to, however it was started.
  checkRunning: boolean
  // The latest attempt of the update check, of any component.
  attemptedAt: string | null
  components: SystemComponent[]
}

interface UpdateRow {
  component: string
  latestPatch: string | null
  latestMinor: string | null
  latestMajor: string | null
  patchSince: Date | null
  eolLine: string | null
  eol: Date | string | null
  checkedAt: Date | null
  attemptedAt: Date
  error: string | null
}

const iso = (value: Date | null) => (value ? value.toISOString() : null)
const day = (value: Date | string | null) => {
  if (!value) return null
  if (typeof value === 'string') return value.slice(0, 10)
  // A date column comes back as local midnight.
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
}

// Same release, whatever the spelling: `18.6-alpine` runs as `18.6.0`,
// `24.21.0-trixie-slim` as `v24.21.0`.
const numbers = (version: string) => parseTag(version.replace(/^v/, '').replace(/[-+].*$/, ''))?.parts ?? null
export const sameRelease = (declared: string, running: string) => {
  const a = numbers(declared)
  const b = numbers(running)
  if (!a || !b) return true
  const length = Math.max(a.length, b.length)
  return Array.from({ length }, (_, i) => (a[i] ?? 0) === (b[i] ?? 0)).every(Boolean)
}

const SOURCE_TIMEOUT_MS = 3000

export class SystemInfoReportService {
  private readonly prometheus: Prometheus
  private readonly netbox: Netbox
  private queue?: Queue
  private events?: QueueEvents
  private closed = false

  constructor(private readonly app: Application) {
    const config = app.get('config')
    this.prometheus = new Prometheus(config)
    this.netbox = new Netbox(config)
  }

  // The connections are opened by the first read, which is somebody opening
  // the page: an api nobody looks at holds none of them.
  private open() {
    if (this.queue || this.closed) return this.queue
    const config = this.app.get('config')
    const connection = queueConnection(config)
    this.queue = new Queue(MAINTENANCE_QUEUE, { connection, prefix: config.queuePrefix })
    this.events = new QueueEvents(MAINTENANCE_QUEUE, { connection, prefix: config.queuePrefix })
    for (const change of CHECK_CHANGES) {
      this.events.on(change, ({ jobId }: { jobId: string }) => {
        if (isUpdateCheckJob(jobId)) this.changed()
      })
    }
    this.events.on('error', (error: Error) =>
      this.app.get('logger').warn({ err: { message: error.message } }, 'update check events unavailable')
    )
    return this.queue
  }

  async teardown() {
    this.closed = true
    await Promise.all([this.events?.close(), this.queue?.close()])
  }

  async checkRunning() {
    const queue = this.open()
    if (!queue) throw new Unavailable('The queues are shut down')
    return updateCheckRunning(queue)
  }

  // Queues a check now (ADR 0032), unless one runs or waits to: each run
  // asks Docker Hub, whose anonymous limits are not to be spent twice.
  async askForCheck() {
    if (this.app.get('config').updateCheck === 'off') throw new BadRequest('The update check is off')
    if (await this.checkRunning()) throw new Conflict('An update check is already running')
    await this.queue!.add(UPDATE_CHECK, {}, UPDATE_CHECK_ASKED_OPTIONS)
  }

  private changed() {
    if (this.closed || !this.anyReader()) return
    this.checkRunning()
      .then((running) => {
        if (this.closed) return
        // A custom event carries no hook context; this one gives the
        // publisher what it needs.
        const status: SystemInfoCheckStatus = { running }
        const service = this.app.service(SYSTEM_INFO_PATH)
        const context = { app: this.app, path: SYSTEM_INFO_PATH, service, event: SYSTEM_INFO_CHECK_EVENT, result: status, dispatch: status }
        service.emit(SYSTEM_INFO_CHECK_EVENT, status, context)
      })
      .catch((error: Error) => this.app.get('logger').warn({ err: { message: error.message } }, 'update check status not published'))
  }

  private anyReader() {
    const channel = subjectChannel(SYSTEM_INFO_PATH)
    return this.app.channels.includes(channel) && this.app.channel(channel).length > 0
  }

  async find(_params?: Params): Promise<SystemInfoReport> {
    const [running, rows, checkRunning] = await Promise.all([
      this.running(),
      this.app.get('knex')<UpdateRow>(COMPONENT_UPDATES_TABLE).select('*'),
      this.checkRunning()
    ])
    const byComponent = new Map(rows.map((row) => [row.component, row]))
    const attempted = rows.map((row) => row.attemptedAt.getTime())
    return {
      app: {
        commit: process.env.APP_COMMIT && process.env.APP_COMMIT !== 'unknown' ? process.env.APP_COMMIT : null,
        commitTime: process.env.APP_COMMIT_TIME && process.env.APP_COMMIT_TIME !== 'unknown' ? process.env.APP_COMMIT_TIME : null,
        dirty: process.env.APP_DIRTY === 'true'
      },
      updateCheck: this.app.get('config').updateCheck,
      checkRunning,
      attemptedAt: attempted.length ? new Date(Math.max(...attempted)).toISOString() : null,
      components: COMPONENTS.map((component) => {
        const declared = inventoryById.get(component.id)
        const live = running.get(component.id) ?? { version: null, missing: 'not-reported' as const }
        const row = byComponent.get(component.id)
        return {
          id: component.id,
          name: component.name,
          image: declared?.image ?? null,
          declared: declared?.version ?? null,
          running: live.version,
          runningMissing: live.version ? null : live.missing,
          drift: !!(declared?.version && live.version && !sameRelease(declared.version, live.version)),
          latestPatch: row?.latestPatch ?? null,
          latestMinor: row?.latestMinor ?? null,
          latestMajor: row?.latestMajor ?? null,
          patchSince: iso(row?.patchSince ?? null),
          eolLine: row?.eolLine ?? null,
          eol: day(row?.eol ?? null),
          checkedAt: iso(row?.checkedAt ?? null),
          error: row?.error ?? null
        }
      })
    }
  }

  // The running version of every component that reports one.
  private async running() {
    type Live = { version: string | null; missing: 'not-reported' | 'source-failed' }
    const result = new Map<string, Live>()
    const failed = (component: Component) => result.set(component.id, { version: null, missing: 'source-failed' })
    const found = (component: Component, version: string | undefined | null) =>
      result.set(component.id, version ? { version, missing: 'not-reported' } : { version: null, missing: 'not-reported' })

    const fromPrometheus = COMPONENTS.filter((component) => component.live.kind === 'prometheus')
    const queries = fromPrometheus.map((component) => (component.live as { query: string }).query)
    const logger = this.app.get('logger')
    await Promise.all([
      this.prometheus
        .series(`{__name__=~"${queries.join('|')}"}`)
        .then((series) => {
          for (const component of fromPrometheus) {
            const live = component.live as { query: string; label: string; strip?: RegExp }
            const labels: Labels | undefined = series.find((each) => each.__name__ === live.query)
            const value = labels?.[live.label]
            found(component, value ? value.replace(live.strip ?? /^$/, '') : null)
          }
        })
        .catch((error: Error) => {
          logger.warn({ err: { message: error.message } }, 'system info: Prometheus unavailable')
          fromPrometheus.forEach(failed)
        }),
      ...COMPONENTS.filter((component) => component.live.kind === 'valkey').map((component) =>
        withTimeout(this.app.get('valkey').info('server'))
          .then((info) => found(component, /^valkey_version:(\S+)/m.exec(info)?.[1]))
          .catch(() => failed(component))
      ),
      ...COMPONENTS.filter((component) => component.live.kind === 'netbox').map((component) =>
        this.netbox
          .status()
          .then((status) => found(component, status['netbox-version']))
          .catch(() => failed(component))
      ),
      ...COMPONENTS.filter((component) => component.live.kind === 'process').map(async (component) => {
        found(component, process.versions.node)
      })
    ])
    return result
  }
}

const withTimeout = <T>(promise: Promise<T>) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), SOURCE_TIMEOUT_MS).unref())
  ])

export const systemInfo = (app: Application) => {
  app.use(SYSTEM_INFO_PATH, new SystemInfoReportService(app), {
    methods: [...SYSTEM_INFO_REPORT_EXTERNAL_METHODS],
    events: [SYSTEM_INFO_CHECK_EVENT]
  })
  // The report goes to the caller only; whether a check runs, to whoever
  // reads the page (ADR 0012).
  app.service(SYSTEM_INFO_PATH).publish(publishNothing)
  app.service(SYSTEM_INFO_PATH).publish(SYSTEM_INFO_CHECK_EVENT, publishTo(app, () => [subjectChannel(SYSTEM_INFO_PATH)]))
}

declare module '../../app.js' {
  interface ServiceTypes {
    [SYSTEM_INFO_PATH]: SystemInfoReportService
  }
}
