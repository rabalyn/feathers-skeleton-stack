<template>
  <q-page padding>
    <h1 class="text-h5 q-mt-none">{{ t('nav.users') }}</h1>
    <q-table
      v-model:pagination="pagination"
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
      <template #body-cell-roles="props">
        <q-td :props="props">
          <q-select
            v-if="mayAssign"
            :model-value="drafts[props.row.id] ?? props.row.roleIds"
            :options="roleOptions"
            multiple
            use-chips
            emit-value
            map-options
            dense
            borderless
            :display-value="(drafts[props.row.id] ?? props.row.roleIds).length ? undefined : t('user.noRoles')"
            :aria-label="t('user.role')"
            @update:model-value="(roleIds: string[]) => (drafts[props.row.id] = roleIds)"
            @popup-hide="commit(props.row)"
          />
          <span v-else>{{ namesOf(props.row.roleIds) }}</span>
        </q-td>
      </template>
      <template #body-cell-enabled="props">
        <q-td :props="props">
          <q-toggle
            :model-value="props.row.enabled"
            :disable="!mayEnable || props.row.authSource === 'local'"
            :aria-label="props.row.enabled ? t('users.disable') : t('users.enable')"
            @update:model-value="(enabled: boolean) => patch(props.row.id, { enabled })"
          />
        </q-td>
      </template>
      <template #body-cell-sessions="props">
        <q-td :props="props" auto-width>
          <q-btn
            v-if="mayViewAs && props.row.id !== session.user?.id && props.row.authSource === 'saml' && !props.row.erasedAt"
            flat
            dense
            round
            icon="preview"
            :aria-label="t('viewAs.start')"
            :title="t('viewAs.start')"
            @click="viewAs(props.row.id)"
          />
          <q-btn
            v-if="session.canAll('read', 'sessions')"
            flat
            dense
            round
            icon="devices"
            :to="{ name: 'sessions', query: { userId: props.row.id } }"
            :aria-label="t('users.sessions')"
            :title="t('users.sessions')"
          />
        </q-td>
      </template>
    </q-table>
  </q-page>
</template>

<script setup lang="ts">
import type { User, UserPatch } from '@app/api/client'
import type { QTableProps } from 'quasar'
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useApi } from '@/boot/feathers'
import { useFormat } from '@/composables/format'
import { useNotify } from '@/composables/notify'
import { useRoles } from '@/composables/roles'
import { useSessionStore } from '@/stores/session'

const api = useApi()
const session = useSessionStore()
const { t } = useI18n()
const { dateTime } = useFormat()
const notify = useNotify()

// Assigning roles is the admin's alone; enabling and disabling is
// users.enable; whoever sees this page reads (ADR 0011).
const mayAssign = computed(() => session.canAll('patch', 'user-roles'))
const mayEnable = computed(() => session.canAll('patch', 'users'))
// Read-only view-as (ADR 0028); the server refuses administrators.
const mayViewAs = computed(() => session.can('create', 'view-as'))

const router = useRouter()
const viewAs = async (id: string) => {
  try {
    await session.startViewAs(id)
    void router.push({ name: 'profile' })
  } catch (error) {
    notify.failure(error)
  }
}

const { roles, name, namesOf } = useRoles()
const roleFilter = ref<string | null>(null)
// `everyone` is held without an assignment (ADR 0011).
const roleOptions = computed(() =>
  roles.value.filter((role) => role.kind !== 'everyone').map((role) => ({ value: role.id, label: name(role) }))
)

// Server-side paging: the table shows one page; the API sorts and counts.
const paging = ref({ page: 1, rowsPerPage: 25, sortBy: 'surname', descending: false })

const params = computed(() => ({
  query: {
    ...(roleFilter.value ? { roleId: roleFilter.value } : {}),
    $sort: { [paging.value.sortBy]: paging.value.descending ? -1 : 1 },
    $limit: paging.value.rowsPerPage,
    $skip: (paging.value.page - 1) * paging.value.rowsPerPage
  }
}))

const users = api.service('users').useFind(params, { paginateOn: 'server' })

// Two-way: QTable reads a bound pagination only while it has an
// update:pagination listener, and otherwise keeps the one it mounted with.
const pagination = computed<NonNullable<QTableProps['pagination']>>({
  get: () => ({ ...paging.value, rowsNumber: users.total }),
  set: (next) => {
    paging.value = {
      page: next.page ?? 1,
      rowsPerPage: next.rowsPerPage ?? 25,
      sortBy: next.sortBy ?? 'surname',
      descending: next.descending ?? false
    }
  }
})

const onRequest: QTableProps['onRequest'] = ({ pagination: next }) => {
  pagination.value = next
}
// Another filter is another list: it starts on its first page.
watch(roleFilter, () => (paging.value = { ...paging.value, page: 1 }))

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
  { name: 'roles', field: 'roleIds', label: t('user.role'), align: 'left' },
  { name: 'enabled', field: 'enabled', label: t('user.enabled'), align: 'center', sortable: true },
  {
    name: 'createdAt',
    field: 'createdAt',
    label: t('user.createdAt'),
    align: 'left',
    sortable: true,
    format: (value: User['createdAt']) => dateTime(value)
  },
  // Under sessions.read (ADR 0011).
  ...(session.canAll('read', 'sessions') || mayViewAs.value ? [{ name: 'sessions', field: 'id', label: '', align: 'right' as const }] : [])
])

// Roles picked while the menu is open, sent as one change when it closes:
// a patch carries the full list, so one per click could overwrite the one
// before it. The server ends the person's sockets, so the new rights apply
// at once (ADR 0012).
const drafts = reactive<Record<string, string[]>>({})
const commit = async (user: User) => {
  const roleIds = drafts[user.id]
  if (!roleIds) return
  if (roleIds.length === user.roleIds.length && roleIds.every((id) => user.roleIds.includes(id))) {
    delete drafts[user.id]
    return
  }
  try {
    await api.service('user-roles').patch(user.id, { roleIds })
    notify.success(t('users.saved'))
  } catch (error) {
    notify.failure(error)
  } finally {
    delete drafts[user.id]
  }
}

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
