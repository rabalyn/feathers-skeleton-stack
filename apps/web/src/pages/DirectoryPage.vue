<template>
  <q-page padding>
    <h1 class="text-h5 q-mt-none">{{ t('nav.directory') }}</h1>
    <q-input
      v-model="term"
      outlined
      clearable
      debounce="300"
      :label="t('directory.search')"
      :hint="t('directory.hint', { min: DIRECTORY_MIN_TERM_LENGTH })"
      :maxlength="DIRECTORY_MAX_TERM_LENGTH"
      class="search"
    >
      <template #prepend><q-icon name="search" /></template>
    </q-input>

    <q-banner v-if="page?.truncated" dense class="bg-orange-1 q-mt-md" role="status">
      {{ t('directory.truncated', { max: DIRECTORY_MAX_RESULTS }) }}
    </q-banner>

    <q-table
      v-model:pagination="pagination"
      :rows="page?.data ?? []"
      :columns="columns"
      row-key="tuId"
      :loading="pending"
      :rows-per-page-options="ROWS_PER_PAGE"
      :no-data-label="page ? t('directory.empty') : t('directory.enterTerm')"
      flat
      bordered
      class="q-mt-md"
      data-test="directory-table"
      @request="onRequest"
    >
      <template #body-cell-account="props">
        <q-td :props="props">
          <q-chip v-if="props.value" dense icon="verified_user">{{ t('directory.hasAccount') }}</q-chip>
        </q-td>
      </template>
    </q-table>
  </q-page>
</template>

<script setup lang="ts">
import {
  DIRECTORY_MAX_RESULTS,
  DIRECTORY_MAX_TERM_LENGTH,
  DIRECTORY_MIN_TERM_LENGTH,
  DIRECTORY_PAGE_MAX,
  type DirectoryEntry,
  type DirectoryPage
} from '@app/api/client'
import type { QTableProps } from 'quasar'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { client } from '@/api/feathers'
import { useNotify } from '@/composables/notify'

// Lookup in the university directory (ADR 0008). Entries are not records of
// this application, so they bypass the service stores. Paginated on the
// server like every list (ADR 0014), within the at most 100 entries one
// search returns, and never more than 50 per page.
const { t } = useI18n()
const notify = useNotify()

const ROWS_PER_PAGE = [10, 25, DIRECTORY_PAGE_MAX]

const term = ref<string | null>('')
const paging = ref({ page: 1, rowsPerPage: 25 })
const page = ref<DirectoryPage | null>(null)
const pending = ref(false)
let latest = 0

// Two-way, as on the sites page: QTable reads a bound pagination only while
// it has an update:pagination listener.
const pagination = computed<NonNullable<QTableProps['pagination']>>({
  get: () => ({ ...paging.value, rowsNumber: page.value?.total ?? 0 }),
  set: (next) => {
    paging.value = { page: next.page ?? 1, rowsPerPage: next.rowsPerPage ?? 25 }
  }
})
const onRequest: QTableProps['onRequest'] = ({ pagination: next }) => {
  pagination.value = next
}

const load = async () => {
  const q = (term.value ?? '').trim()
  const request = ++latest
  if (q.length < DIRECTORY_MIN_TERM_LENGTH) {
    page.value = null
    pending.value = false
    return
  }
  pending.value = true
  try {
    const { page: current, rowsPerPage } = paging.value
    const result = await client.service('directory').find({
      query: { q, $limit: rowsPerPage, $skip: (current - 1) * rowsPerPage }
    })
    // Answers can overtake each other; only the latest counts.
    if (request === latest) page.value = result
  } catch (error) {
    if (request === latest) notify.failure(error)
  } finally {
    if (request === latest) pending.value = false
  }
}

watch(paging, () => void load())
// Another search is another list: it starts on its first page.
watch(term, () => (paging.value = { ...paging.value, page: 1 }))

const columns = computed<NonNullable<QTableProps['columns']>>(() => [
  {
    name: 'name',
    field: (entry: DirectoryEntry) => [entry.givenName, entry.surname].filter(Boolean).join(' '),
    label: t('directory.name'),
    align: 'left',
    classes: 'text-weight-bold'
  },
  { name: 'tuId', field: 'tuId', label: t('directory.tuId'), align: 'left' },
  { name: 'email', field: 'email', label: t('directory.email'), align: 'left' },
  { name: 'account', field: 'userId', label: '', align: 'right' }
])
</script>

<style scoped>
.search {
  max-width: 640px;
}
</style>
