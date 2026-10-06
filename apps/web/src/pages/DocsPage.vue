<template>
  <q-page padding>
    <h1 class="text-h5 q-mt-none q-mb-sm">{{ t('nav.docs') }}</h1>

    <q-tabs
      :model-value="tab"
      dense
      no-caps
      align="left"
      outside-arrows
      mobile-arrows
      class="text-primary"
      data-test="docs-tabs"
      @update:model-value="openTab"
    >
      <q-tab v-for="diagram in diagrams" :key="diagram.id" :name="diagram.id" :label="tabLabel(diagram)" :data-test="`docs-tab-${diagram.id}`" />
      <q-tab :name="ADR_TAB" icon="gavel" :label="t('docs.adrs')" data-test="docs-tab-adrs" />
      <q-tab v-if="hasProductAdrs" :name="PRODUCT_TAB" icon="gavel" :label="t('docs.productAdrs')" data-test="docs-tab-product" />
    </q-tabs>
    <q-separator class="q-mb-md" />

    <div v-if="tab in SOURCE_OF_TAB" class="row q-col-gutter-lg">
      <div class="col-12 col-md-4 col-lg-3">
        <q-input
          v-model="term"
          outlined
          dense
          clearable
          debounce="300"
          :label="t('docs.search')"
          :maxlength="DOC_SEARCH_MAX_LENGTH"
          :loading="searching"
          data-test="docs-search"
        >
          <template #prepend><q-icon name="search" /></template>
        </q-input>
        <q-list dense class="q-mt-sm adr-list" data-test="docs-adr-list">
          <q-item
            v-for="adr in adrs"
            :key="adr.id"
            clickable
            :active="adr.id === selected"
            :data-test="`docs-adr-${adr.id}`"
            @click="open(adr.id)"
          >
            <q-item-section>
              <q-item-label>
                <span v-if="adr.number" class="text-weight-medium">{{ adr.number }}</span>
                {{ shortTitle(adr) }}
              </q-item-label>
              <q-item-label v-if="adr.excerpt" caption lines="2">{{ adr.excerpt }}</q-item-label>
            </q-item-section>
            <q-item-section v-if="adr.status && adr.status !== 'Accepted'" side>
              <q-badge color="grey-6" :label="adr.status" />
            </q-item-section>
          </q-item>
          <q-item v-if="!adrs.length && !searching">
            <q-item-section class="text-grey-7" data-test="docs-no-match">{{ t('docs.noMatch') }}</q-item-section>
          </q-item>
        </q-list>
      </div>
      <div class="col-12 col-md-8 col-lg-9">
        <DocView v-if="doc" :doc="doc" :docs="all" :href-of="hrefOf" :hash="hash" @navigate="open" />
      </div>
    </div>
    <DocView v-else-if="doc" :doc="doc" :docs="all" :href-of="hrefOf" :hash="hash" @navigate="open" />

    <q-inner-loading :showing="loading" />
  </q-page>
</template>

<script setup lang="ts">
import { DOC_SEARCH_MAX_LENGTH, type Doc, type DocSource, type DocSummary } from '@app/api/client'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { client } from '@/api/feathers'
import DocView from '@/components/DocView.vue'
import { useNotify } from '@/composables/notify'

// The architecture documentation (ADR 0019), under `docs.read`, the
// admin's alone (ADR 0011): a tab per diagram page, the skeleton's and then
// the product's, and the ADRs with a search over their text, the
// skeleton's on one tab and the product's on another, there once the
// product has one (ADR 0035). The page shown is in the address,
// `?page=<id>`, so it can be linked and the back button works.

const ADR_TAB = 'adrs'
const PRODUCT_TAB = 'product'
const SOURCE_OF_TAB: Record<string, DocSource> = { [ADR_TAB]: 'skeleton', [PRODUCT_TAB]: 'product' }

const { t } = useI18n()
const notify = useNotify()
const route = useRoute()
const router = useRouter()

const all = ref<DocSummary[]>([])
const found = ref<DocSummary[]>()
const doc = ref<Doc>()
const term = ref<string | null>('')
const loading = ref(false)
const searching = ref(false)

const diagrams = computed(() => all.value.filter((entry) => entry.kind === 'diagram'))
const hasProductAdrs = computed(() => all.value.some((entry) => entry.source === 'product' && entry.kind === 'adr'))

const selected = computed(() => (typeof route.query.page === 'string' ? route.query.page : undefined))
const hash = computed(() => route.hash.slice(1))
const entryOf = (id: string | undefined) => all.value.find((entry) => entry.id === id)
const tab = computed(() => {
  const entry = entryOf(selected.value)
  if (entry?.kind === 'diagram') return entry.id
  return entry?.source === 'product' ? PRODUCT_TAB : ADR_TAB
})
// The ADRs of the tab shown, or of the one asked for, with their index.
const adrsOf = (name: string) =>
  (found.value ?? all.value).filter((entry) => entry.kind !== 'diagram' && entry.source === SOURCE_OF_TAB[name])
const adrs = computed(() => adrsOf(tab.value))

const TAB_LABELS: Record<string, string> = { 'diagrams-readme': 'docs.overview', 'product-diagrams-readme': 'docs.productOverview' }
const tabLabel = (entry: DocSummary) => (entry.id in TAB_LABELS ? t(TAB_LABELS[entry.id]!) : entry.label)
const shortTitle = (entry: DocSummary) => entry.title.replace(/^\d{4}:\s*/, '')

const hrefOf = (id: string, target: string) => router.resolve({ name: 'docs', query: { page: id }, hash: target ? `#${target}` : '' }).href

const open = (id: string, target = '') => void router.push({ name: 'docs', query: { page: id }, hash: target ? `#${target}` : '' })
const INDEX_OF_TAB: Record<string, string> = { [ADR_TAB]: 'readme', [PRODUCT_TAB]: 'product-readme' }
// An ADR tab opens the first page of its list: its index, or the first
// match of a search.
const openTab = (value: string | number) => {
  const name = String(value)
  open(name in SOURCE_OF_TAB ? (adrsOf(name)[0]?.id ?? INDEX_OF_TAB[name]!) : name)
}

const load = async () => {
  loading.value = true
  try {
    all.value = await client.service('docs').find()
    if (!entryOf(selected.value)) {
      await router.replace({ name: 'docs', query: { page: diagrams.value[0]?.id ?? 'readme' } })
    }
  } catch (error) {
    notify.failure(error)
  } finally {
    loading.value = false
  }
}

const show = async (id: string | undefined) => {
  if (!id || doc.value?.id === id) return
  try {
    doc.value = await client.service('docs').get(id)
  } catch (error) {
    notify.failure(error)
  }
}

let asked = 0
const search = async (value: string | null) => {
  const q = value?.trim()
  const current = ++asked
  if (!q) {
    found.value = undefined
    return
  }
  searching.value = true
  try {
    const result = await client.service('docs').find({ query: { q } })
    if (current === asked) found.value = result.filter((entry) => entry.kind !== 'diagram')
  } catch (error) {
    notify.failure(error)
  } finally {
    if (current === asked) searching.value = false
  }
}

watch(selected, show, { immediate: true })
watch(term, search)
onMounted(load)
</script>

<style scoped>
.adr-list {
  max-height: calc(100vh - 220px);
  overflow-y: auto;
}
</style>
