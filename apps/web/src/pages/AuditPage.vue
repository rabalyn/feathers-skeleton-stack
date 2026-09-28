<template>
  <q-page padding>
    <h1 class="text-h5 q-mt-none">{{ t('nav.audit') }}</h1>
    <q-table
      v-model:pagination="pagination"
      :rows="rows"
      :columns="columns"
      row-key="id"
      :loading="events.isPending"
      :rows-per-page-options="[25, 50, 100]"
      :no-data-label="t('audit.empty')"
      flat
      bordered
      data-test="audit-table"
      @request="onRequest"
    >
      <template #top-right>
        <q-select
          v-model="actionFilter"
          :options="actionOptions"
          :label="t('audit.action')"
          emit-value
          map-options
          clearable
          dense
          outlined
          class="action-filter"
        />
      </template>
    </q-table>
  </q-page>
</template>

<script setup lang="ts">
import type { AuditEvent, User } from '@app/api/client'
import type { QTableProps } from 'quasar'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useApi } from '@/boot/feathers'
import { useAuditLabels } from '@/composables/audit'
import { useFormat } from '@/composables/format'

// Every audit event, for admins and operators (ADR 0011, 0013); newest
// first, filterable by action. Accounts show by TU-ID where they still have
// one; erased and system accounts by what remains.

const api = useApi()
const { t } = useI18n()
const { dateTime } = useFormat()
const { action } = useAuditLabels()

// The actions the skeleton records (apps/api/src/audit.ts).
const ACTIONS = [
  'login',
  'login.refused',
  'logout',
  'session.reuse-detected',
  'sessions.revoke',
  'users.patch',
  'users.erase',
  'settings.update',
  'breakglass.create',
  'breakglass.rotate',
  'data-exports.create',
  'data-exports.download'
]
const actionFilter = ref<string | null>(null)
const actionOptions = computed(() => ACTIONS.map((value) => ({ value, label: action(value) })))

const paging = ref({ page: 1, rowsPerPage: 50 })
const params = computed(() => ({
  query: {
    ...(actionFilter.value ? { action: actionFilter.value } : {}),
    $sort: { occurredAt: -1 },
    $limit: paging.value.rowsPerPage,
    $skip: (paging.value.page - 1) * paging.value.rowsPerPage
  }
}))
const events = api.service('audit-events').useFind(params, { paginateOn: 'server' })
const rows = computed(() => events.data as AuditEvent[])
// Two-way: QTable reads a bound pagination only while it has an
// update:pagination listener, and otherwise keeps the one it mounted with.
const pagination = computed<NonNullable<QTableProps['pagination']>>({
  get: () => ({ ...paging.value, rowsNumber: events.total }),
  set: (next) => {
    paging.value = { page: next.page ?? 1, rowsPerPage: next.rowsPerPage ?? 50 }
  }
})

const onRequest: QTableProps['onRequest'] = ({ pagination: next }) => {
  pagination.value = next
}
// Another filter is another list: it starts on its first page.
watch(actionFilter, () => (paging.value = { ...paging.value, page: 1 }))

const accounts = ref(new Map<string, User>())
watch(
  () => rows.value.map((event) => event.actorId).filter((id): id is string => !!id),
  async (ids) => {
    const missing = [...new Set(ids)].filter((id) => !accounts.value.has(id))
    if (!missing.length) return
    const found = await api.service('users').find({ query: { id: { $in: missing }, $limit: missing.length } })
    for (const user of found.data as User[]) accounts.value.set(user.id, user)
  },
  { immediate: true }
)
const accountLabel = (id: string | null) => {
  if (!id) return t('audit.system')
  const user = accounts.value.get(id)
  if (user?.erasedAt) return t('audit.erased', { id: id.slice(0, 8) })
  return user?.tuId ?? user?.email ?? id.slice(0, 8)
}

const columns = computed<NonNullable<QTableProps['columns']>>(() => [
  { name: 'occurredAt', field: 'occurredAt', label: t('audit.time'), align: 'left', format: (value: string) => dateTime(value) },
  { name: 'actor', field: 'actorId', label: t('audit.actor'), align: 'left', format: accountLabel },
  { name: 'action', field: 'action', label: t('audit.action'), align: 'left', format: action },
  {
    name: 'resource',
    field: (event: AuditEvent) => [event.resourceType, event.resourceId?.slice(0, 8)].filter(Boolean).join(' '),
    label: t('audit.resource'),
    align: 'left'
  },
  {
    name: 'detail',
    field: (event: AuditEvent) => (Object.keys(event.detail).length ? JSON.stringify(event.detail) : ''),
    label: t('audit.detail'),
    align: 'left',
    classes: 'detail'
  }
])
</script>

<style scoped>
.action-filter {
  min-width: 240px;
}
:deep(.detail) {
  font-family: monospace;
  white-space: normal;
  word-break: break-all;
}
</style>
