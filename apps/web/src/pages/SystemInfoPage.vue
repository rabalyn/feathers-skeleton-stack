<template>
  <q-page padding>
    <div class="row items-center q-mb-md">
      <h1 class="text-h5 q-my-none col">{{ t('nav.systemInfo') }}</h1>
      <q-btn
        v-if="mayCheck"
        flat
        color="primary"
        icon="update"
        :label="t('systemInfo.checkNow')"
        :loading="asking || !!report?.checkRunning"
        data-test="system-info-check-now"
        @click="checkNow"
      />
      <q-btn flat icon="refresh" :label="t('systemInfo.refresh')" :loading="loading" data-test="system-info-refresh" @click="load" />
    </div>

    <template v-if="report">
      <q-card flat bordered class="q-mb-md">
        <q-card-section class="row q-col-gutter-md">
          <div class="col-12 col-md-6" data-test="system-info-app">
            <div class="text-subtitle2">{{ t('systemInfo.app') }}</div>
            <template v-if="report.app.commit">
              <span class="text-mono">{{ report.app.commit }}</span>
              <q-badge v-if="report.app.dirty" class="q-ml-sm" color="warning" text-color="dark" :label="t('systemInfo.dirty')" />
              <div v-if="report.app.commitTime" class="text-caption text-grey-7">
                {{ t('systemInfo.committed', { time: dateTime(report.app.commitTime) }) }}
              </div>
            </template>
            <span v-else class="text-grey-7">{{ t('systemInfo.unknown') }}</span>
          </div>
          <div class="col-12 col-md-6" data-test="system-info-check">
            <div class="text-subtitle2">{{ t('systemInfo.updateCheck') }}</div>
            <template v-if="report.updateCheck === 'off'">{{ t('systemInfo.checkOff') }}</template>
            <div v-else-if="report.checkRunning" data-test="system-info-check-running">
              <q-spinner class="q-mr-xs" /> {{ t('systemInfo.checkRunning') }}
            </div>
            <template v-else-if="report.attemptedAt">{{ t('systemInfo.lastCheck', { time: dateTime(report.attemptedAt) }) }}</template>
            <template v-else>{{ t('systemInfo.notCheckedYet') }}</template>
          </div>
        </q-card-section>
        <q-card-section v-if="patches || endingSoon" class="q-pt-none row q-gutter-sm">
          <q-chip v-if="patches" icon="system_update" color="warning" text-color="dark" data-test="system-info-patches">
            {{ t('systemInfo.patchesWaiting', patches) }}
          </q-chip>
          <q-chip v-if="endingSoon" icon="event_busy" color="negative" text-color="white" data-test="system-info-eol-soon">
            {{ t('systemInfo.eolSoon', endingSoon) }}
          </q-chip>
        </q-card-section>
      </q-card>

      <q-markup-table flat bordered dense separator="horizontal" data-test="system-info-components">
        <thead>
          <tr>
            <th class="text-left">{{ t('systemInfo.component') }}</th>
            <th class="text-left">{{ t('systemInfo.declared') }}</th>
            <th class="text-left">{{ t('systemInfo.running') }}</th>
            <th class="text-left">{{ t('systemInfo.patch') }}</th>
            <th class="text-left">{{ t('systemInfo.minor') }}</th>
            <th class="text-left">{{ t('systemInfo.major') }}</th>
            <th class="text-left">{{ t('systemInfo.eol') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in report.components" :key="row.id" :data-test="`component-${row.id}`">
            <td>
              <div class="text-weight-medium">{{ row.name }}</div>
              <div v-if="row.image" class="text-caption text-grey-7 text-mono">{{ row.image }}</div>
              <div v-if="row.error" class="text-caption text-negative" :data-test="`component-${row.id}-error`">
                <q-icon name="error_outline" /> {{ t('systemInfo.checkFailed') }}
                <q-tooltip>{{ row.error }}</q-tooltip>
              </div>
            </td>
            <td class="text-mono">{{ row.declared ?? '—' }}</td>
            <td :data-test="`component-${row.id}-running`">
              <span v-if="row.running" class="text-mono">{{ row.running }}</span>
              <span v-else-if="row.runningMissing === 'source-failed'" class="text-warning">{{ t('systemInfo.sourceFailed') }}</span>
              <span v-else class="text-grey-6">{{ t('systemInfo.notReported') }}</span>
              <q-badge v-if="row.drift" class="q-ml-sm" color="warning" text-color="dark" :label="t('systemInfo.drift')">
                <q-tooltip>{{ t('systemInfo.driftHint') }}</q-tooltip>
              </q-badge>
            </td>
            <td :data-test="`component-${row.id}-patch`">
              <template v-if="row.latestPatch">
                <q-badge color="warning" text-color="dark" class="text-mono" :label="row.latestPatch" />
                <div v-if="row.patchSince" class="text-caption text-grey-7">{{ t('systemInfo.since', { date: date(row.patchSince) }) }}</div>
              </template>
              <!-- Without an image there is nothing to compare: PgBouncer, the host. -->
              <span v-else-if="row.image && row.checkedAt" class="text-positive">{{ t('systemInfo.current') }}</span>
            </td>
            <td class="text-mono">{{ row.latestMinor ?? '' }}</td>
            <td class="text-mono">{{ row.latestMajor ?? '' }}</td>
            <td :data-test="`component-${row.id}-eol`">
              <span v-if="row.eol" :class="eolClass(row.eol)">{{ date(row.eol) }}</span>
              <span v-else-if="row.eolLine" class="text-grey-7">{{ t('systemInfo.noEolDate') }}</span>
              <div v-if="row.eolLine" class="text-caption text-grey-7">{{ t('systemInfo.line', { line: row.eolLine }) }}</div>
            </td>
          </tr>
        </tbody>
      </q-markup-table>
    </template>
  </q-page>
</template>

<script setup lang="ts">
import type { SystemInfoReport } from '@app/api/client'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { client } from '@/api/feathers'
import { useFormat } from '@/composables/format'
import { useNotify } from '@/composables/notify'
import { useSessionStore } from '@/stores/session'

// What runs and which updates are out (ADR 0032), the admin's alone: per
// component the pinned version, the running one, the newest patch, minor and
// major the daily check found, and the end of life of the running line.
// A patch is what to deploy; a minor or major is a planning matter.
// Whoever holds `system-info.check` may run the check now; the api's `check`
// event says when a check starts and ends, however it was started, and the
// page reads the report again when one has ended (ADR 0012).

const { t, locale } = useI18n()
const { dateTime } = useFormat()
const notify = useNotify()
const session = useSessionStore()

// The Grafana alert's horizon (ADR 0032).
const EOL_WARNING_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000

const report = ref<SystemInfoReport>()
const loading = ref(false)
const asking = ref(false)

const mayCheck = computed(() => report.value?.updateCheck === 'on' && session.can('create', 'update-checks'))

const date = (value: string) => new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium' }).format(new Date(value))
const daysUntil = (value: string) => (Date.parse(value) - Date.now()) / DAY_MS
const eolClass = (value: string) => {
  const days = daysUntil(value)
  if (days < 0) return 'text-negative text-weight-bold'
  if (days < EOL_WARNING_DAYS) return 'text-warning text-weight-medium'
  return ''
}

const patches = computed(() => report.value?.components.filter((row) => row.latestPatch).length ?? 0)
const endingSoon = computed(
  () => report.value?.components.filter((row) => row.eol && daysUntil(row.eol) < EOL_WARNING_DAYS).length ?? 0
)

const load = async () => {
  loading.value = true
  try {
    report.value = await client.service('system-info').find()
  } catch (error) {
    notify.failure(error)
  } finally {
    loading.value = false
  }
}

const checkNow = async () => {
  asking.value = true
  try {
    await client.service('update-checks').create({})
    if (report.value) report.value.checkRunning = true
  } catch (error) {
    // Somebody else's check, or the night's, is already under way.
    if ((error as { code?: number }).code === 409) {
      if (report.value) report.value.checkRunning = true
    } else notify.failure(error)
  } finally {
    asking.value = false
  }
}

// The events arrive in order, each from a read after the queue changed; a
// report read in between can be older than the latest event.
let lastRunning = false
const onCheck = ({ running }: { running: boolean }) => {
  lastRunning = running
  if (!report.value) return
  const ended = report.value.checkRunning && !running
  report.value.checkRunning = running
  if (!ended) return
  void load().then(() => {
    if (report.value) report.value.checkRunning = lastRunning
  })
}
// The session store re-authenticates a reconnected socket; events may have
// been missed meanwhile.
const onLogin = () => void load()

onMounted(() => {
  client.service('system-info').on('check', onCheck)
  client.on('login', onLogin)
  void load()
})
onUnmounted(() => {
  client.service('system-info').removeListener('check', onCheck)
  client.removeListener('login', onLogin)
})
</script>

<style scoped>
.text-mono {
  font-family: monospace;
}
</style>
