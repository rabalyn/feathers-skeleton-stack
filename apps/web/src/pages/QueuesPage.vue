<template>
  <q-page padding>
    <div class="row items-center q-mb-md">
      <h1 class="text-h5 q-my-none col">{{ t('nav.queues') }}</h1>
      <q-chip
        dense
        :icon="live ? 'sensors' : 'sensors_off'"
        :color="live ? 'positive' : 'grey-6'"
        text-color="white"
        :label="live ? t('queues.live') : t('queues.offline')"
        data-test="queues-live"
      />
    </div>

    <q-card v-for="queue in queues" :key="queue.id" flat bordered class="q-mb-lg" :data-test="`queue-${queue.id}`" :data-updated="queue.updatedAt">
      <q-card-section class="row items-center q-gutter-sm">
        <h2 class="text-h6 q-my-none">{{ queueLabel(queue.id) }}</h2>
        <q-badge v-if="queue.paused" color="warning" text-color="dark" :label="t('queues.paused')" />
        <q-space />
        <span class="text-caption text-grey-7">{{ t('queues.updated', { time: time(queue.updatedAt) }) }}</span>
      </q-card-section>

      <q-card-section class="row q-gutter-sm q-pt-none">
        <q-chip
          v-for="state in COUNTED"
          :key="state"
          square
          :color="queue.counts[state] && state !== 'completed' ? STATE_COLORS[state] : 'grey-3'"
          :text-color="queue.counts[state] && state !== 'completed' ? 'white' : 'dark'"
          :data-test="`queue-${queue.id}-${state}`"
        >
          <span class="text-weight-bold q-mr-xs">{{ queue.counts[state] }}</span>
          {{ t(`queues.states.${state}`) }}
        </q-chip>
      </q-card-section>

      <q-card-section v-if="queue.rateLimit" class="q-pt-none text-body2">
        {{ t('queues.rateLimit', { max: queue.rateLimit.max, window: span(queue.rateLimit.durationMs) }) }}
        <span v-if="throttledFor(queue) > 0" class="text-warning text-weight-medium">
          · {{ t('queues.throttled', { in: span(throttledFor(queue)) }) }}
        </span>
      </q-card-section>

      <q-card-section v-if="queue.schedulers.length" class="q-pt-none">
        <div class="text-subtitle2 q-mb-xs">{{ t('queues.schedules') }}</div>
        <q-markup-table flat dense bordered separator="horizontal" :data-test="`queue-${queue.id}-schedules`">
          <thead>
            <tr>
              <th class="text-left">{{ t('queues.job') }}</th>
              <th class="text-left">{{ t('queues.schedule') }}</th>
              <th class="text-left">{{ t('queues.nextRun') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="scheduler in queue.schedulers" :key="scheduler.key">
              <td>{{ jobLabel(scheduler.name) }}</td>
              <td>{{ schedule(scheduler) }}</td>
              <td>
                <template v-if="scheduler.nextAt">{{ dateTime(scheduler.nextAt) }} ({{ relative(scheduler.nextAt) }})</template>
              </td>
            </tr>
          </tbody>
        </q-markup-table>
      </q-card-section>

      <q-card-section class="q-pt-none">
        <div class="text-subtitle2 q-mb-xs">{{ t('queues.jobs') }}</div>
        <q-table
          :rows="queue.jobs"
          :columns="columns"
          row-key="id"
          flat
          bordered
          dense
          :pagination="{ rowsPerPage: 10 }"
          :no-data-label="t('queues.idle')"
          :data-test="`queue-${queue.id}-jobs`"
        >
          <template #body-cell-state="props">
            <q-td :props="props">
              <q-badge :color="STATE_COLORS[props.row.state as QueueJobState]" :label="t(`queues.states.${props.row.state}`)" />
            </q-td>
          </template>
        </q-table>
        <div v-if="truncated(queue)" class="text-caption text-grey-7 q-mt-xs">{{ t('queues.truncated') }}</div>
      </q-card-section>
    </q-card>
  </q-page>
</template>

<script setup lang="ts">
import type { QueueJob, QueueJobState, QueueScheduler, QueueStatus } from '@app/api/client'
import type { QTableProps } from 'quasar'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { client, socket } from '@/api/feathers'
import { useFormat } from '@/composables/format'
import { useNotify } from '@/composables/notify'

// The job queues (ADR 0024), the admin's alone (ADR 0011): what the worker
// is doing and will do, read-only. The page reads every queue once, then
// follows the `status` events the api sends when a queue changes (ADR 0012).
// Once a reconnected socket has authenticated again, when events may have
// been missed, it reads them again.

const i18n = useI18n()
const { t, locale } = i18n
const { dateTime } = useFormat()
const notify = useNotify()

const COUNTED = ['active', 'waiting', 'prioritized', 'delayed', 'failed', 'completed'] as const
const STATE_COLORS: Record<QueueJobState | 'completed', string> = {
  active: 'primary',
  waiting: 'info',
  prioritized: 'info',
  delayed: 'secondary',
  failed: 'negative',
  completed: 'positive'
}

const queues = ref<QueueStatus[]>([])
const live = ref(socket.connected)

// A clock for the relative times, ticking while the page is open.
const now = ref(Date.now())

const translated = (key: string, fallback: string) => (i18n.te(key) ? t(key) : fallback)
const queueLabel = (name: string) => translated(`queues.names.${name}`, name)
const jobLabel = (name: string) => translated(`queues.jobNames.${name}`, name)

const time = (value: string) => new Intl.DateTimeFormat(locale.value, { timeStyle: 'medium' }).format(new Date(value))
const relative = (value: string) => {
  const seconds = Math.round((Date.parse(value) - now.value) / 1000)
  const format = new Intl.RelativeTimeFormat(locale.value, { numeric: 'auto' })
  const abs = Math.abs(seconds)
  if (abs < 60) return format.format(seconds, 'second')
  if (abs < 3600) return format.format(Math.round(seconds / 60), 'minute')
  if (abs < 86_400) return format.format(Math.round(seconds / 3600), 'hour')
  return format.format(Math.round(seconds / 86_400), 'day')
}
// A duration such as a rate limit's window, in its largest whole unit.
const span = (ms: number) => {
  const seconds = Math.ceil(ms / 1000)
  const [value, unit] =
    seconds % 3600 === 0 && seconds >= 3600
      ? [seconds / 3600, 'hour']
      : seconds % 60 === 0 && seconds >= 60
        ? [seconds / 60, 'minute']
        : seconds >= 120
          ? [Math.ceil(seconds / 60), 'minute']
          : [seconds, 'second']
  return new Intl.NumberFormat(locale.value, { style: 'unit', unit, unitDisplay: 'long' }).format(value)
}
const schedule = (scheduler: QueueScheduler) =>
  scheduler.pattern
    ? t('queues.cron', { pattern: scheduler.pattern, tz: scheduler.tz ?? 'UTC' })
    : scheduler.everyMs
      ? t('queues.every', { span: span(scheduler.everyMs) })
      : ''

// How long the rate limit still holds jobs back, counted down locally
// from the time of the status.
const throttledFor = (queue: QueueStatus) =>
  queue.rateLimit ? Math.max(0, Date.parse(queue.updatedAt) + queue.rateLimit.resetsInMs - now.value) : 0

const truncated = (queue: QueueStatus) =>
  queue.jobs.length < queue.counts.active + queue.counts.waiting + queue.counts.prioritized + queue.counts.delayed + queue.counts.failed

// The time that matters for the job's state.
const when = (job: QueueJob) => {
  switch (job.state) {
    case 'delayed':
      return job.dueAt ? t('queues.dueAt', { time: relative(job.dueAt) }) : ''
    case 'active':
      return job.processedAt ? t('queues.startedAt', { time: relative(job.processedAt) }) : ''
    case 'failed':
      return job.finishedAt ? dateTime(job.finishedAt) : ''
    default:
      return t('queues.since', { time: relative(job.createdAt) })
  }
}

const columns = computed<NonNullable<QTableProps['columns']>>(() => [
  { name: 'state', field: 'state', label: t('queues.state'), align: 'left' },
  { name: 'name', field: 'name', label: t('queues.job'), align: 'left', format: (value: string) => jobLabel(value) },
  { name: 'id', field: 'id', label: t('queues.id'), align: 'left', classes: 'text-mono', format: (value: string) => (value.length > 12 ? `${value.slice(0, 8)}…` : value) },
  { name: 'attempts', field: (row: QueueJob) => `${row.attemptsMade}/${row.attempts}`, label: t('queues.attempts'), align: 'right' },
  { name: 'createdAt', field: 'createdAt', label: t('queues.createdAt'), align: 'left', format: (value: string) => dateTime(value) },
  { name: 'when', field: (row: QueueJob) => when(row), label: t('queues.when'), align: 'left' }
])

const load = async () => {
  try {
    queues.value = await client.service('queues').find()
  } catch (error) {
    notify.failure(error)
  }
}

const onStatus = (status: QueueStatus) => {
  const index = queues.value.findIndex((queue) => queue.id === status.id)
  // An older status than the one shown loses.
  if (index >= 0 && queues.value[index]!.updatedAt > status.updatedAt) return
  if (index >= 0) queues.value.splice(index, 1, status)
  else queues.value.push(status)
}
// The session store re-authenticates a reconnected socket; reading before
// that would be refused.
const onLogin = () => {
  live.value = true
  void load()
}
const onDisconnect = () => {
  live.value = false
}

let clock: ReturnType<typeof setInterval> | undefined
onMounted(async () => {
  client.service('queues').on('status', onStatus)
  client.on('login', onLogin)
  socket.on('disconnect', onDisconnect)
  clock = setInterval(() => (now.value = Date.now()), 1000)
  await load()
})
onUnmounted(() => {
  client.service('queues').removeListener('status', onStatus)
  client.removeListener('login', onLogin)
  socket.off('disconnect', onDisconnect)
  clearInterval(clock)
})
</script>

<style scoped>
.text-mono {
  font-family: monospace;
}
</style>
