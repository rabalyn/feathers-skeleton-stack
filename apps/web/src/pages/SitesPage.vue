<template>
  <q-page padding>
    <h1 class="text-h5 q-mt-none">{{ t('nav.sites') }}</h1>
    <q-table
      v-model:pagination="pagination"
      :rows="page?.data ?? []"
      :columns="columns"
      row-key="id"
      :loading="pending"
      :rows-per-page-options="[25, 50]"
      :no-data-label="t('sites.empty')"
      flat
      bordered
      data-test="sites-table"
      @request="onRequest"
    >
      <template #top-right>
        <q-input
          v-model="term"
          outlined
          dense
          clearable
          debounce="300"
          :label="t('sites.search')"
          :hint="t('sites.hint')"
          :maxlength="SITE_SEARCH_MAX_LENGTH"
          class="search"
        >
          <template #prepend><q-icon name="search" /></template>
        </q-input>
      </template>
      <template #body-cell-occupants="props">
        <q-td :props="props" class="occupants">
          <div v-for="line in props.value" :key="line">{{ line }}</div>
        </q-td>
      </template>
      <template #body-cell-netbox="props">
        <q-td :props="props">
          <q-btn
            flat
            dense
            round
            icon="open_in_new"
            :href="props.value"
            target="_blank"
            rel="noopener"
            :aria-label="t('sites.openInNetbox')"
          >
            <q-tooltip>{{ t('sites.openInNetbox') }}</q-tooltip>
          </q-btn>
        </q-td>
      </template>
    </q-table>
  </q-page>
</template>

<script setup lang="ts">
import { SITE_SEARCH_MAX_LENGTH, type Site, type SitePage } from '@app/api/client'
import type { QTableProps } from 'quasar'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { client } from '@/api/feathers'
import { useNotify } from '@/composables/notify'

// The address lookup (ADR 0031): the university's buildings from NetBox.
// They are not records of this application, so they bypass the service
// stores, like the directory. Paginated on the server like every list
// (ADR 0014).

const { t, locale } = useI18n()
const notify = useNotify()

const term = ref<string | null>('')
const paging = ref({ page: 1, rowsPerPage: 25 })
const page = ref<SitePage | null>(null)
const pending = ref(false)
let latest = 0

const english = computed(() => locale.value.startsWith('en'))

// Two-way, as on the audit log: QTable reads a bound pagination only while
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
  const request = ++latest
  pending.value = true
  try {
    const q = (term.value ?? '').trim()
    const { page: current, rowsPerPage } = paging.value
    const result = await client.service('sites').find({
      query: { ...(q ? { q } : {}), $limit: rowsPerPage, $skip: (current - 1) * rowsPerPage }
    })
    // Answers can overtake each other; only the latest counts.
    if (request === latest) page.value = result
  } catch (error) {
    if (request === latest) notify.failure(error)
  } finally {
    if (request === latest) pending.value = false
  }
}

watch(paging, () => void load(), { immediate: true })
// Another search is another list: it starts on its first page.
watch(term, () => (paging.value = { ...paging.value, page: 1 }))

const columns = computed<NonNullable<QTableProps['columns']>>(() => [
  { name: 'key', field: 'key', label: t('sites.key'), align: 'left', classes: 'text-weight-bold' },
  { name: 'name', field: (site: Site) => (english.value && site.nameEn) || site.name, label: t('sites.name'), align: 'left' },
  {
    name: 'address',
    field: (site: Site) => [site.street, [site.postalCode, site.city].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    label: t('sites.address'),
    align: 'left'
  },
  {
    name: 'occupants',
    field: (site: Site) => (english.value && site.occupants.en.length ? site.occupants.en : site.occupants.de),
    label: t('sites.occupants'),
    align: 'left'
  },
  { name: 'netbox', field: 'netboxUrl', label: '', align: 'right' }
])
</script>

<style scoped>
.search {
  min-width: 320px;
}
.occupants {
  white-space: normal;
  font-size: 0.85em;
}
</style>
