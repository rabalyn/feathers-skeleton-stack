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
      :loading="pending"
      class="search"
    >
      <template #prepend><q-icon name="search" /></template>
    </q-input>

    <q-banner v-if="page?.truncated" dense class="bg-orange-1 q-mt-md" role="status">
      {{ t('directory.truncated') }}
    </q-banner>

    <q-list v-if="page" bordered separator class="q-mt-md results">
      <q-item v-for="entry in page.data" :key="entry.tuId">
        <q-item-section>
          <q-item-label>{{ [entry.givenName, entry.surname].filter(Boolean).join(' ') }}</q-item-label>
          <q-item-label caption>{{ [entry.tuId, entry.email].filter(Boolean).join(' · ') }}</q-item-label>
        </q-item-section>
        <q-item-section v-if="entry.userId" side>
          <q-chip dense icon="verified_user">{{ t('directory.hasAccount') }}</q-chip>
        </q-item-section>
      </q-item>
      <q-item v-if="page.data.length === 0">
        <q-item-section>{{ t('directory.empty') }}</q-item-section>
      </q-item>
    </q-list>
  </q-page>
</template>

<script setup lang="ts">
import {
  DIRECTORY_MAX_RESULTS,
  DIRECTORY_MAX_TERM_LENGTH,
  DIRECTORY_MIN_TERM_LENGTH,
  type DirectoryPage
} from '@app/api/client'
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { client } from '@/api/feathers'
import { useNotify } from '@/composables/notify'

// Lookup in the university directory (ADR 0008). Entries are not records of
// this application, so they bypass the service stores.
const { t } = useI18n()
const notify = useNotify()

const term = ref<string | null>('')
const page = ref<DirectoryPage | null>(null)
const pending = ref(false)
let latest = 0

watch(term, async (value) => {
  const q = (value ?? '').trim()
  const request = ++latest
  if (q.length < DIRECTORY_MIN_TERM_LENGTH) {
    page.value = null
    return
  }
  pending.value = true
  try {
    const result = await client.service('directory').find({ query: { q, $limit: DIRECTORY_MAX_RESULTS } })
    // Answers can overtake each other; only the latest counts.
    if (request === latest) page.value = result
  } catch (error) {
    if (request === latest) notify.failure(error)
  } finally {
    if (request === latest) pending.value = false
  }
})
</script>

<style scoped>
.search,
.results {
  max-width: 640px;
}
</style>
