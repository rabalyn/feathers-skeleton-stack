<template>
  <q-page padding>
    <h1 class="text-h5 q-mt-none">{{ t('nav.sites') }}</h1>
    <q-input
      v-model="term"
      outlined
      clearable
      debounce="300"
      :label="t('sites.search')"
      :hint="t('sites.hint')"
      :maxlength="SITE_SEARCH_MAX_LENGTH"
      :loading="pending"
      class="search"
    >
      <template #prepend><q-icon name="search" /></template>
    </q-input>

    <q-list v-if="page" bordered separator class="q-mt-md results" data-testid="sites">
      <q-expansion-item v-for="site in page.data" :key="site.id" :data-testid="`site-${site.key}`">
        <template #header>
          <q-item-section avatar>
            <q-chip dense square class="text-weight-bold">{{ site.key }}</q-chip>
          </q-item-section>
          <q-item-section>
            <q-item-label>{{ nameOf(site) }}</q-item-label>
            <q-item-label caption>{{ addressOf(site) }}</q-item-label>
          </q-item-section>
        </template>
        <q-card flat>
          <q-card-section class="q-pt-none">
            <div v-if="site.group" class="text-caption text-grey-8">{{ site.group.name }}</div>
            <div class="text-subtitle2 q-mt-sm">{{ t('sites.occupants') }}</div>
            <ul v-if="occupantsOf(site).length" class="q-my-xs">
              <li v-for="line in occupantsOf(site)" :key="line">{{ line }}</li>
            </ul>
            <div v-else class="text-grey-8">{{ t('sites.noOccupants') }}</div>
            <q-btn flat dense no-caps icon="open_in_new" :href="site.netboxUrl" target="_blank" rel="noopener" :label="t('sites.openInNetbox')" />
          </q-card-section>
        </q-card>
      </q-expansion-item>
      <q-item v-if="page.data.length === 0">
        <q-item-section>{{ t('sites.empty') }}</q-item-section>
      </q-item>
    </q-list>

    <div v-if="page && pages > 1" class="q-mt-md results flex flex-center">
      <q-pagination v-model="current" :max="pages" :max-pages="7" direction-links boundary-links />
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { SITE_SEARCH_MAX_LENGTH, type Site, type SitePage } from '@app/api/client'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { client } from '@/api/feathers'
import { useNotify } from '@/composables/notify'

// The address lookup (ADR 0031): the university's buildings from NetBox.
// They are not records of this application, so they bypass the service
// stores, like the directory.
const PAGE_SIZE = 20

const { t, locale } = useI18n()
const notify = useNotify()

const term = ref<string | null>('')
const current = ref(1)
const page = ref<SitePage | null>(null)
const pending = ref(false)
let latest = 0

const pages = computed(() => (page.value ? Math.ceil(page.value.total / PAGE_SIZE) : 0))
const english = computed(() => locale.value.startsWith('en'))

const nameOf = (site: Site) => (english.value && site.nameEn) || site.name
const addressOf = (site: Site) =>
  [site.street, [site.postalCode, site.city].filter(Boolean).join(' ')].filter(Boolean).join(', ')
const occupantsOf = (site: Site) => {
  const { de, en } = site.occupants
  return english.value && en.length ? en : de
}

const load = async () => {
  const request = ++latest
  pending.value = true
  try {
    const q = (term.value ?? '').trim()
    const result = await client.service('sites').find({
      query: { ...(q ? { q } : {}), $limit: PAGE_SIZE, $skip: (current.value - 1) * PAGE_SIZE }
    })
    // Answers can overtake each other; only the latest counts.
    if (request === latest) page.value = result
  } catch (error) {
    if (request === latest) notify.failure(error)
  } finally {
    if (request === latest) pending.value = false
  }
}

watch(term, () => {
  if (current.value === 1) void load()
  else current.value = 1
})
watch(current, () => void load())
void load()
</script>

<style scoped>
.search,
.results {
  max-width: 720px;
}
</style>
