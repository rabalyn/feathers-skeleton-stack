<template>
  <div class="column q-gutter-sm">
    <div class="row items-center q-gutter-sm">
      <q-btn
        color="primary"
        no-caps
        icon="archive"
        :label="subjectId === session.user?.id ? t('exports.requestOwn') : t('exports.request')"
        :loading="busy"
        :disable="pending"
        data-test="export-request"
        @click="request"
      />
      <span v-if="pending" class="text-caption" data-test="export-pending">{{ t('exports.pending') }}</span>
    </div>
    <q-list v-if="rows.length" bordered separator data-test="export-list">
      <q-item v-for="row in rows" :key="row.id" :data-state="row.state">
        <q-item-section>
          <q-item-label>{{ t(`exports.states.${row.state}`) }} · {{ dateTime(row.createdAt) }}</q-item-label>
          <q-item-label caption>
            <template v-if="row.state === 'ready'">
              {{ bytes(row.sizeBytes) }} · {{ t('exports.expires', { date: dateTime(row.expiresAt) }) }}
            </template>
            <template v-else-if="row.state === 'failed'">{{ t('exports.failedHint') }}</template>
            <template v-else>{{ t('exports.pendingHint') }}</template>
          </q-item-label>
        </q-item-section>
        <q-item-section side>
          <q-btn
            v-if="row.state === 'ready'"
            flat
            no-caps
            icon="download"
            :label="t('exports.download')"
            data-test="export-download"
            @click="download(row)"
          />
          <q-spinner v-else-if="row.state === 'pending'" size="sm" />
        </q-item-section>
      </q-item>
    </q-list>
  </div>
</template>

<script setup lang="ts">
import type { DataExport } from '@app/api/client'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { downloadExport } from '@/api/files'
import { useApi } from '@/boot/feathers'
import { useFormat } from '@/composables/format'
import { useNotify } from '@/composables/notify'
import { useSessionStore } from '@/stores/session'

// GDPR exports of one person that the caller asked for (ADR 0013): request
// one, follow it live until the worker is done (ADR 0012), download it.

const props = defineProps<{ subjectId: string }>()

const api = useApi()
const session = useSessionStore()
const { t } = useI18n()
const { dateTime, bytes } = useFormat()
const notify = useNotify()

const params = computed(() => ({
  query: {
    subjectId: props.subjectId,
    requestedBy: session.user?.id ?? '',
    $sort: { createdAt: -1 },
    $limit: 5
  }
}))
const exports = api.service('data-exports').useFind(params, { paginateOn: 'server' })
const rows = computed(() => exports.data as DataExport[])
const pending = computed(() => rows.value.some((row) => row.state === 'pending'))

const busy = ref(false)
const request = async () => {
  busy.value = true
  try {
    await api.service('data-exports').create({ subjectId: props.subjectId })
    await exports.find()
  } catch (error) {
    if ((error as { code?: number }).code === 409) notify.success(t('exports.pending'))
    else notify.failure(error)
  } finally {
    busy.value = false
  }
}

const download = async (row: DataExport) => {
  try {
    await downloadExport(row.id, row.createdAt)
  } catch (error) {
    notify.failure(error)
  }
}
</script>
