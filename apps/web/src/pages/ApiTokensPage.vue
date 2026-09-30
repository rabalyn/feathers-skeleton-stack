<template>
  <q-page padding>
    <div class="row items-center q-mb-sm">
      <h1 class="text-h5 q-my-none col">{{ t('nav.apiTokens') }}</h1>
      <q-btn
        v-if="session.can('create', 'api-tokens')"
        color="primary"
        no-caps
        icon="add"
        :label="t('apiTokens.new')"
        data-test="api-token-new"
        @click="openCreate"
      />
    </div>
    <p class="text-body2 text-grey-8 intro">{{ t('apiTokens.intro') }}</p>
    <pre class="usage q-pa-sm">{{ usage }}</pre>

    <q-table
      v-model:pagination="pagination"
      :rows="rows"
      :columns="columns"
      row-key="id"
      :loading="tokens.isPending"
      :rows-per-page-options="[25, 50, 100]"
      :no-data-label="t('apiTokens.empty')"
      flat
      bordered
      data-test="api-tokens-table"
      @request="onRequest"
    >
      <template #body-cell-permissions="props">
        <q-td :props="props">
          <q-chip v-for="key in props.row.permissions" :key="key" dense square :label="labels.label(key)" :title="key" />
        </q-td>
      </template>
      <template #body-cell-expiresAt="props">
        <q-td :props="props">
          <q-badge v-if="expired(props.row)" color="negative" :label="t('apiTokens.expired')" />
          <span v-else>{{ props.row.expiresAt ? dateTime(props.row.expiresAt) : t('apiTokens.never') }}</span>
        </q-td>
      </template>
      <template #body-cell-actions="props">
        <q-td :props="props" auto-width>
          <q-btn
            v-if="mayRevoke(props.row)"
            flat
            dense
            no-caps
            color="negative"
            icon="block"
            :label="t('apiTokens.revoke')"
            :loading="revoking === props.row.id"
            data-test="api-token-revoke"
            @click="confirmRevoke(props.row)"
          />
        </q-td>
      </template>
    </q-table>

    <q-dialog v-model="editing">
      <q-card class="editor">
        <q-form @submit.prevent="save">
          <q-card-section>
            <div class="text-h6">{{ t('apiTokens.new') }}</div>
          </q-card-section>
          <q-card-section class="q-gutter-md">
            <q-input
              v-model="draft.name"
              outlined
              maxlength="80"
              :label="t('apiTokens.name')"
              :rules="[(value: string) => value.trim().length > 0 || t('apiTokens.nameRequired')]"
              data-test="api-token-name"
            />
            <q-input
              v-model="draft.expiresOn"
              outlined
              type="date"
              stack-label
              clearable
              :min="tomorrow"
              :label="t('apiTokens.expiresOn')"
              :hint="t('apiTokens.expiresHint')"
              data-test="api-token-expiry"
            />
            <div>
              <div class="text-subtitle2">{{ t('apiTokens.permissions') }}</div>
              <div class="text-caption text-grey-7 q-mb-xs">{{ t('apiTokens.permissionsHint') }}</div>
              <div v-if="!grantable.length" class="text-body2">{{ t('apiTokens.nothingGrantable') }}</div>
              <div v-for="key in grantable" :key="key">
                <q-checkbox v-model="draft.permissions" :val="key" :label="labels.label(key)" :data-permission="key" />
                <div class="text-caption text-grey-7 description">{{ labels.description(key) }}</div>
              </div>
            </div>
          </q-card-section>
          <q-card-actions align="right">
            <q-btn v-close-popup flat no-caps :label="t('apiTokens.cancel')" />
            <q-btn
              type="submit"
              color="primary"
              no-caps
              :label="t('apiTokens.create')"
              :disable="!draft.permissions.length"
              :loading="saving"
              data-test="api-token-create"
            />
          </q-card-actions>
        </q-form>
      </q-card>
    </q-dialog>

    <!-- The token, once: it is stored nowhere and shown nowhere again. -->
    <q-dialog :model-value="created !== null" persistent @update:model-value="created = null">
      <q-card v-if="created" class="editor">
        <q-card-section>
          <div class="text-h6">{{ t('apiTokens.createdTitle') }}</div>
          <p class="text-body2 q-mt-sm">{{ t('apiTokens.createdText') }}</p>
          <q-input
            :model-value="created"
            outlined
            readonly
            class="token"
            :label="t('apiTokens.token')"
            data-test="api-token-value"
          >
            <template #append>
              <q-btn flat dense icon="content_copy" :aria-label="t('apiTokens.copy')" :title="t('apiTokens.copy')" @click="copy" />
            </template>
          </q-input>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn color="primary" no-caps :label="t('apiTokens.done')" data-test="api-token-done" @click="created = null" />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-page>
</template>

<script setup lang="ts">
import { API_PREFIX, TOKEN_PERMISSION_KEYS, subject, type ApiToken, type User } from '@app/api/client'
import type { Params } from '@feathersjs/feathers'
import { copyToClipboard, useQuasar, type QTableProps } from 'quasar'
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { client } from '@/api/feathers'
import { useApi } from '@/boot/feathers'
import { useFormat } from '@/composables/format'
import { useNotify } from '@/composables/notify'
import { usePermissionLabels } from '@/composables/roles'
import { useSessionStore } from '@/stores/session'

// API tokens (ADR 0029): one's own, or everybody's under api-tokens.manage,
// following creations and revocations live (ADR 0012). A new token carries
// permissions its creator holds, and is shown once, right after it is made.

const api = useApi()
const session = useSessionStore()
const $q = useQuasar()
const { t } = useI18n()
const { dateTime } = useFormat()
const notify = useNotify()
const labels = usePermissionLabels()

// A command, not prose: the same in every language.
const usage = `curl -H "Authorization: Bearer apt_…" ${window.location.origin}${API_PREFIX}/users`
const managesAll = computed(() => session.canAll('read', 'api-tokens'))

const paging = ref({ page: 1, rowsPerPage: 25 })
const params = computed(() => ({
  query: {
    $sort: { createdAt: -1 },
    $limit: paging.value.rowsPerPage,
    $skip: (paging.value.page - 1) * paging.value.rowsPerPage
  }
}))
const tokens = api.service('api-tokens').useFind(params, { paginateOn: 'server' })
const rows = computed(() => tokens.data as ApiToken[])
const pagination = computed<NonNullable<QTableProps['pagination']>>({
  get: () => ({ ...paging.value, rowsNumber: tokens.total }),
  set: (next) => {
    paging.value = { page: next.page ?? 1, rowsPerPage: next.rowsPerPage ?? 25 }
  }
})
const onRequest: QTableProps['onRequest'] = ({ pagination: next }) => {
  pagination.value = next
}

// Owners' names, for those who see everybody's tokens.
const accounts = ref(new Map<string, User>())
watch(
  () => (managesAll.value ? rows.value.map((row) => row.userId) : []),
  async (ids) => {
    const missing = [...new Set(ids)].filter((id) => !accounts.value.has(id))
    if (!missing.length || !session.canAll('read', 'users')) return
    const found = await api.service('users').find({ query: { id: { $in: missing }, $limit: missing.length } })
    for (const user of found.data as User[]) accounts.value.set(user.id, user)
  },
  { immediate: true }
)
const ownerLabel = (id: string) => {
  if (id === session.user?.id) return t('apiTokens.you')
  const user = accounts.value.get(id)
  if (!user) return id.slice(0, 8)
  return [user.givenName, user.surname].filter(Boolean).join(' ') + (user.tuId ? ` (${user.tuId})` : '')
}

const expired = (row: ApiToken) => row.expiresAt !== null && Date.parse(row.expiresAt) <= Date.now()
const mayRevoke = (row: ApiToken) => session.ability?.can('delete', subject('api-tokens', { ...row })) ?? false

// What a token may carry: what the creator holds, less what no token may.
const grantable = computed(() => {
  const held = new Set(session.user?.permissions ?? [])
  return TOKEN_PERMISSION_KEYS.filter((key) => held.has(key))
})

const toDateInput = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
const tomorrow = computed(() => toDateInput(new Date(Date.now() + 86_400_000)))

const editing = ref(false)
const saving = ref(false)
const draft = reactive<{ name: string; expiresOn: string | null; permissions: string[] }>({ name: '', expiresOn: null, permissions: [] })
const openCreate = () => {
  Object.assign(draft, { name: '', expiresOn: null, permissions: [] })
  editing.value = true
}

const created = ref<string | null>(null)
const save = async () => {
  saving.value = true
  try {
    // The end of the chosen day, where the browser is.
    const expiresAt = draft.expiresOn ? new Date(`${draft.expiresOn}T23:59:59`).toISOString() : null
    // Not into the service store, so the token is kept by this dialog only;
    // the list gets the record from the `created` event, which has none.
    const result = await client
      .service('api-tokens')
      .create({ name: draft.name.trim(), permissions: draft.permissions, expiresAt }, { skipStore: true } as Params)
    editing.value = false
    created.value = result.token ?? null
  } catch (error) {
    notify.failure(error)
  } finally {
    saving.value = false
  }
}

const copy = async () => {
  if (!created.value) return
  try {
    await copyToClipboard(created.value)
    notify.success(t('apiTokens.copied'))
  } catch (error) {
    notify.failure(error)
  }
}

const revoking = ref<string | null>(null)
const confirmRevoke = (row: ApiToken) => {
  $q.dialog({
    title: t('apiTokens.revoke'),
    message: t('apiTokens.revokeConfirm', { name: row.name }),
    cancel: { flat: true, noCaps: true, label: t('apiTokens.cancel') },
    ok: { color: 'negative', noCaps: true, label: t('apiTokens.revoke') }
  }).onOk(() => void revoke(row))
}

const revoke = async (row: ApiToken) => {
  revoking.value = row.id
  try {
    await api.service('api-tokens').remove(row.id)
    notify.success(t('apiTokens.revoked'))
  } catch (error) {
    notify.failure(error)
  } finally {
    revoking.value = null
  }
}

const columns = computed<NonNullable<QTableProps['columns']>>(() => [
  { name: 'name', field: 'name', label: t('apiTokens.name'), align: 'left' },
  ...(managesAll.value
    ? [{ name: 'owner', field: (row: ApiToken) => ownerLabel(row.userId), label: t('apiTokens.owner'), align: 'left' as const }]
    : []),
  { name: 'hint', field: (row: ApiToken) => `apt_…${row.hint}`, label: t('apiTokens.token'), align: 'left' },
  { name: 'permissions', field: 'permissions', label: t('apiTokens.permissions'), align: 'left' },
  { name: 'createdAt', field: 'createdAt', label: t('apiTokens.createdAt'), align: 'left', format: (value: string) => dateTime(value) },
  { name: 'expiresAt', field: 'expiresAt', label: t('apiTokens.expiresAt'), align: 'left' },
  {
    name: 'lastUsedAt',
    field: 'lastUsedAt',
    label: t('apiTokens.lastUsedAt'),
    align: 'left',
    format: (value: string | null) => (value ? dateTime(value) : t('apiTokens.unused'))
  },
  { name: 'actions', field: 'id', label: '', align: 'right' }
])
</script>

<style scoped>
.intro {
  max-width: 60rem;
}
.usage {
  background: rgba(0, 0, 0, 0.05);
  border-radius: 4px;
  overflow-x: auto;
  max-width: 60rem;
}
.editor {
  width: 36rem;
  max-width: 95vw;
}
.description {
  margin-left: 2.5rem;
  margin-top: -0.5rem;
}
.token :deep(input) {
  font-family: monospace;
}
</style>
