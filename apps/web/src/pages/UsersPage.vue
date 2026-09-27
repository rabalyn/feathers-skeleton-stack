<template>
  <q-page padding>
    <h1 class="text-h5 q-mt-none">{{ t('nav.users') }}</h1>
    <q-table
      :pagination="pagination"
      :rows="users.data"
      :columns="columns"
      row-key="id"
      :loading="users.isPending"
      :rows-per-page-options="[10, 25, 50, 100]"
      :no-data-label="t('users.empty')"
      flat
      bordered
      @request="onRequest"
    >
      <template #top-right>
        <q-select
          v-model="roleFilter"
          :options="roleOptions"
          :label="t('user.role')"
          emit-value
          map-options
          clearable
          dense
          outlined
          class="role-filter"
        />
      </template>
      <template #body-cell-role="props">
        <q-td :props="props">
          <q-select
            v-if="mayPatch"
            :model-value="props.row.role"
            :options="roleOptions"
            emit-value
            map-options
            dense
            borderless
            :aria-label="t('user.role')"
            @update:model-value="(role: Role) => patch(props.row.id, { role })"
          />
          <span v-else>{{ t(`user.roles.${props.row.role}`) }}</span>
        </q-td>
      </template>
      <template #body-cell-enabled="props">
        <q-td :props="props">
          <q-toggle
            :model-value="props.row.enabled"
            :disable="!mayPatch"
            :aria-label="props.row.enabled ? t('users.disable') : t('users.enable')"
            @update:model-value="(enabled: boolean) => patch(props.row.id, { enabled })"
          />
        </q-td>
      </template>
    </q-table>
  </q-page>
</template>

<script setup lang="ts">
import { ROLES, type Role, type User, type UserPatch } from '@app/api/client'
import type { QTableProps } from 'quasar'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useApi } from '@/boot/feathers'
import { useFormat } from '@/composables/format'
import { useNotify } from '@/composables/notify'
import { useSessionStore } from '@/stores/session'

const api = useApi()
const session = useSessionStore()
const { t } = useI18n()
const { dateTime } = useFormat()
const notify = useNotify()

// Role and enable/disable are admin actions; an operator reads (ADR 0011).
const mayPatch = computed(() => session.canAll('patch', 'users'))

const roleFilter = ref<Role | null>(null)
const roleOptions = computed(() => ROLES.map((role) => ({ value: role, label: t(`user.roles.${role}`) })))

// Server-side paging: the table shows one page; the API sorts and counts.
const paging = ref({ page: 1, rowsPerPage: 25, sortBy: 'surname', descending: false })

const params = computed(() => ({
  query: {
    ...(roleFilter.value ? { role: roleFilter.value } : {}),
    $sort: { [paging.value.sortBy]: paging.value.descending ? -1 : 1 },
    $limit: paging.value.rowsPerPage,
    $skip: (paging.value.page - 1) * paging.value.rowsPerPage
  }
}))

const users = api.service('users').useFind(params, { paginateOn: 'server' })

const pagination = computed(() => ({ ...paging.value, rowsNumber: users.total }))

const onRequest: QTableProps['onRequest'] = ({ pagination: next }) => {
  paging.value = {
    page: next.page ?? 1,
    rowsPerPage: next.rowsPerPage ?? 25,
    sortBy: next.sortBy ?? 'surname',
    descending: next.descending ?? false
  }
}

const columns = computed<NonNullable<QTableProps['columns']>>(() => [
  {
    name: 'tuId',
    field: 'tuId',
    label: t('user.tuId'),
    align: 'left',
    sortable: true,
    // An erased account has no identifiers left (ADR 0013).
    format: (value: User['tuId'], row: User) => (row.erasedAt ? t('users.erased') : (value ?? ''))
  },
  { name: 'givenName', field: 'givenName', label: t('user.givenName'), align: 'left', sortable: true },
  { name: 'surname', field: 'surname', label: t('user.surname'), align: 'left', sortable: true },
  { name: 'email', field: 'email', label: t('user.email'), align: 'left', sortable: true },
  { name: 'role', field: 'role', label: t('user.role'), align: 'left', sortable: true },
  { name: 'enabled', field: 'enabled', label: t('user.enabled'), align: 'center', sortable: true },
  {
    name: 'createdAt',
    field: 'createdAt',
    label: t('user.createdAt'),
    align: 'left',
    sortable: true,
    format: (value: User['createdAt']) => dateTime(value)
  }
])

const patch = async (id: string, data: UserPatch) => {
  try {
    await api.service('users').patch(id, data)
    notify.success(t('users.saved'))
  } catch (error) {
    notify.failure(error)
  }
}
</script>

<style scoped>
.role-filter {
  min-width: 200px;
}
</style>
