<template>
  <!-- eslint-disable-next-line vue/no-v-html -- the repository's own Markdown, raw HTML escaped and the result sanitized (composables/docs.ts, ADR 0019) -->
  <article ref="root" class="doc-view" :data-test="`doc-${doc.id}`" @click="follow" v-html="html" />
</template>

<script setup lang="ts">
import type { Doc, DocSummary } from '@app/api/client'
import type { Mermaid } from 'mermaid'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { createRenderer, DOC_HASH_ATTRIBUTE, DOC_LINK_ATTRIBUTE, MERMAID_CLASS } from '@/composables/docs'

// One page of the ADRs or the diagrams (ADR 0019), with its Mermaid
// diagrams drawn. A link to another page is followed in the app.

const props = defineProps<{
  doc: Doc
  docs: readonly DocSummary[]
  hrefOf: (id: string, hash: string) => string
  // The heading to show, from the address.
  hash?: string
}>()
const emit = defineEmits<{ navigate: [id: string, hash: string] }>()

const root = ref<HTMLElement>()
const html = computed(() => createRenderer(props.doc.path, props.docs, props.hrefOf)(props.doc.markdown))

const follow = (event: MouseEvent) => {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
  const link = (event.target as HTMLElement).closest<HTMLAnchorElement>(`a[${DOC_LINK_ATTRIBUTE}]`)
  if (!link) return
  event.preventDefault()
  emit('navigate', link.getAttribute(DOC_LINK_ATTRIBUTE)!, link.getAttribute(DOC_HASH_ATTRIBUTE) ?? '')
}

// Mermaid is large: loaded with the first diagram. `strict` sanitizes the
// labels and allows no clicks or scripts in a diagram.
let mermaid: Promise<Mermaid> | undefined
const loadMermaid = () =>
  (mermaid ??= import('mermaid').then(({ default: loaded }) => {
    loaded.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' })
    return loaded
  }))

let generation = 0
let counter = 0
const draw = async () => {
  const current = ++generation
  await nextTick()
  const blocks = [...(root.value?.querySelectorAll<HTMLElement>(`.${MERMAID_CLASS}`) ?? [])]
  if (blocks.length) {
    const renderer = await loadMermaid()
    for (const block of blocks) {
      if (current !== generation) return
      try {
        const { svg } = await renderer.render(`doc-mermaid-${++counter}`, block.textContent ?? '')
        if (current !== generation) return
        block.innerHTML = svg
        block.classList.add('drawn')
      } catch {
        // Left as its source, which still says what it shows.
        block.classList.add('failed')
      }
    }
  }
  if (current === generation) scrollToHash()
}

const scrollToHash = () => {
  if (!props.hash) return
  root.value?.querySelector(`#${CSS.escape(props.hash)}`)?.scrollIntoView()
}

onMounted(draw)
watch(html, draw)
watch(() => props.hash, scrollToHash)
</script>

<style scoped>
.doc-view {
  max-width: 1100px;
  line-height: 1.6;
}
.doc-view :deep(h1) {
  font-size: 1.75rem;
  line-height: 1.3;
  margin: 0 0 16px;
}
.doc-view :deep(h2) {
  font-size: 1.35rem;
  line-height: 1.3;
  margin: 28px 0 12px;
}
.doc-view :deep(h3) {
  font-size: 1.1rem;
  line-height: 1.3;
  margin: 20px 0 8px;
}
.doc-view :deep(table) {
  border-collapse: collapse;
  margin: 12px 0;
  display: block;
  overflow-x: auto;
}
.doc-view :deep(th),
.doc-view :deep(td) {
  border: 1px solid rgba(0, 0, 0, 0.12);
  padding: 4px 8px;
  text-align: left;
  vertical-align: top;
}
.doc-view :deep(code) {
  font-family: ui-monospace, monospace;
  font-size: 0.9em;
  background: rgba(0, 0, 0, 0.05);
  padding: 1px 4px;
  border-radius: 3px;
}
.doc-view :deep(pre) {
  background: rgba(0, 0, 0, 0.05);
  padding: 12px;
  overflow-x: auto;
  border-radius: 4px;
}
.doc-view :deep(pre code) {
  background: none;
  padding: 0;
}
.doc-view :deep(.doc-mermaid) {
  margin: 16px 0;
  overflow-x: auto;
  white-space: pre;
  font-family: ui-monospace, monospace;
  font-size: 0.85em;
}
.doc-view :deep(.doc-mermaid.drawn) {
  white-space: normal;
  font-family: inherit;
  font-size: inherit;
  text-align: center;
}
.doc-view :deep(.doc-link-elsewhere) {
  color: inherit;
  text-decoration: underline dotted;
}
</style>
