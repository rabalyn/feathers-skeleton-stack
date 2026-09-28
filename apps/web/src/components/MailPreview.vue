<template>
  <div class="mail-preview">
    <div class="text-subtitle1 text-weight-medium q-mb-sm" data-test="mail-preview-subject">{{ mail.subject }}</div>
    <q-tabs v-model="view" dense align="left" no-caps class="text-primary">
      <q-tab name="html" :label="t('mail.html')" />
      <q-tab name="text" :label="t('mail.text')" />
    </q-tabs>
    <q-separator />
    <!-- Rendered by the server from escaped Markdown; sandboxed all the same. -->
    <iframe v-if="view === 'html'" class="frame" sandbox="" :title="t('mail.previewFrame')" :srcdoc="mail.html" />
    <pre v-else class="text" data-test="mail-preview-text">{{ mail.text }}</pre>
  </div>
</template>

<script setup lang="ts">
import type { MailPreview } from '@app/api/client'
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

// A rendered mail (ADR 0027): its HTML part in a frame that may run nothing,
// and its plain-text part.
defineProps<{ mail: MailPreview }>()
const { t } = useI18n()
const view = ref<'html' | 'text'>('html')
</script>

<style scoped>
.frame {
  width: 100%;
  height: 480px;
  border: 0;
  background: #f4f4f4;
}
.text {
  white-space: pre-wrap;
  font-family: ui-monospace, monospace;
  margin: 0;
  padding: 12px;
}
</style>
