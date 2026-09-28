<template>
  <q-list separator data-test="audit-list">
    <q-item v-for="event in rows" :key="event.id">
      <q-item-section>
        <q-item-label>{{ action(event.action) }}</q-item-label>
        <q-item-label caption>{{ dateTime(event.occurredAt) }}</q-item-label>
      </q-item-section>
    </q-item>
    <q-item v-if="!rows.length && !events.isPending">
      <q-item-section class="text-grey-7">{{ t('audit.empty') }}</q-item-section>
    </q-item>
  </q-list>
</template>

<script setup lang="ts">
import type { AuditEvent } from '@app/api/client'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useApi } from '@/boot/feathers'
import { useAuditLabels } from '@/composables/audit'
import { useFormat } from '@/composables/format'

// The latest audit events one account caused (ADR 0011, 0013).

const props = defineProps<{ actorId: string; limit: number }>()

const api = useApi()
const { t } = useI18n()
const { dateTime } = useFormat()
const { action } = useAuditLabels()

const params = computed(() => ({
  query: { actorId: props.actorId, $sort: { occurredAt: -1 }, $limit: props.limit }
}))
const events = api.service('audit-events').useFind(params, { paginateOn: 'server' })
const rows = computed(() => events.data as AuditEvent[])
</script>
