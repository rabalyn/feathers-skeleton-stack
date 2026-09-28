<template>
  <q-page padding>
    <h1 class="text-h5 q-mt-none">{{ t('nav.sessions') }}</h1>
    <q-table
      :pagination="pagination"
      :rows="rows"
      :columns="columns"
      row-key="id"
      :loading="sessions.isPending"
      :rows-per-page-options="[25, 50, 100]"
      :no-data-label="t('sessions.empty')"
      flat
      bordered
      data-test="sessions-table"
      @request="onRequest"
    >
      <template #top-right>
        <q-chip
          v-if="userFilter"
          removable
          icon="person"
          :label="accountLabel(userFilter)"
          data-test="sessions-filter"
          @remove="filterBy(null)"
        />
      </template>
      <template #body-cell-user="props">
        <q-td :props="props">
          <q-btn
            flat
            dense
            no-caps
            :label="accountLabel(props.row.userId)"
            :title="t('sessions.filterBy')"
            @click="filterBy(props.row.userId)"
          />
        </q-td>
      </template>
      <template #body-cell-actions="props">
        <q-td :props="props" auto-width>
          <q-badge v-if="props.row.id === session.sessionId" color="primary" :label="t('sessions.current')" />
          <q-btn
            v-else-if="mayRevoke(props.row)"
            flat
            dense
            no-caps
            color="negative"
            icon="block"
            :label="t('sessions.revoke')"
            :loading="revoking === props.row.id"
            :data-session="props.row.id"
            data-test="session-revoke"
            @click="revoke(props.row)"
          />
        </q-td>
      </template>
    </q-table>
  </q-page>
</template>

<script setup lang="ts">
import { subject, type Session, type User } from '@app/api/client'
import type { QTableProps } from 'quasar'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { describeUserAgent } from '@/api/user-agent'
import { useApi } from '@/boot/feathers'
import { useFormat } from '@/composables/format'
import { useNotify } from '@/composables/notify'
import { useSessionStore } from '@/stores/session'

// Every active session, for admins and operators (ADR 0010, 0011), most
// recently used first; filtered by person through `?userId=`, which a click
// on a person sets and the Users page links to. Admins revoke; operators do
// not see the browser of other people's sessions.

const api = useApi()
const session = useSessionStore()
const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const { dateTime } = useFormat()
const notify = useNotify()

const userFilter = computed(() => (typeof route.query.userId === 'string' ? route.query.userId : null))
const filterBy = (userId: string | null) => {
  paging.value = { ...paging.value, page: 1 }
  void router.replace({ query: userId ? { userId } : {} })
}

const paging = ref({ page: 1, rowsPerPage: 50 })
const params = computed(() => ({
  query: {
    ...(userFilter.value ? { userId: userFilter.value } : {}),
    $sort: { lastUsedAt: -1 },
    $limit: paging.value.rowsPerPage,
    $skip: (paging.value.page - 1) * paging.value.rowsPerPage
  }
}))
const sessions = api.service('sessions').useFind(params, { paginateOn: 'server' })
const rows = computed(() => sessions.data as Session[])
const pagination = computed(() => ({ ...paging.value, rowsNumber: sessions.total }))

const onRequest: QTableProps['onRequest'] = ({ pagination: next }) => {
  paging.value = { page: next.page ?? 1, rowsPerPage: next.rowsPerPage ?? 50 }
}

const accounts = ref(new Map<string, User>())
watch(
  () => [...rows.value.map((row) => row.userId), ...(userFilter.value ? [userFilter.value] : [])],
  async (ids) => {
    const missing = [...new Set(ids)].filter((id) => !accounts.value.has(id))
    if (!missing.length) return
    const found = await api.service('users').find({ query: { id: { $in: missing }, $limit: missing.length } })
    for (const user of found.data as User[]) accounts.value.set(user.id, user)
  },
  { immediate: true }
)
const accountLabel = (id: string) => {
  const user = accounts.value.get(id)
  if (!user) return id.slice(0, 8)
  return [user.givenName, user.surname].filter(Boolean).join(' ') + (user.tuId ? ` (${user.tuId})` : '')
}

const mayRevoke = (row: Session) => session.ability?.can('delete', subject('sessions', { ...row })) ?? false

const revoking = ref<string | null>(null)
const revoke = async (row: Session) => {
  revoking.value = row.id
  try {
    await api.service('sessions').remove(row.id)
    notify.success(t('sessions.revoked'))
  } catch (error) {
    notify.failure(error)
  } finally {
    revoking.value = null
  }
}

const columns = computed<NonNullable<QTableProps['columns']>>(() => [
  { name: 'user', field: 'userId', label: t('sessions.person'), align: 'left' },
  {
    name: 'browser',
    // Absent for operators on other people's sessions (ADR 0011).
    field: (row: Session) => (row.userAgent === undefined ? '—' : (describeUserAgent(row.userAgent) ?? t('sessions.unknownBrowser'))),
    label: t('sessions.browser'),
    align: 'left'
  },
  { name: 'issuedAt', field: 'issuedAt', label: t('sessions.issuedAt'), align: 'left', format: (value: string) => dateTime(value) },
  { name: 'lastUsedAt', field: 'lastUsedAt', label: t('sessions.lastUsedAt'), align: 'left', format: (value: string) => dateTime(value) },
  {
    name: 'expiresAt',
    field: 'idleExpiresAt',
    label: t('sessions.expiresAt'),
    align: 'left',
    format: (value: string) => dateTime(value)
  },
  { name: 'actions', field: 'id', label: '', align: 'right' }
])
</script>
