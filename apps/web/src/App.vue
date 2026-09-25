<template>
  <div v-if="session.status === 'starting'" class="fullscreen flex flex-center column q-gutter-md" role="status">
    <q-spinner size="lg" color="primary" />
    <div>{{ session.unavailable ? t('auth.unavailable') : t('app.loading') }}</div>
    <q-btn v-if="session.unavailable" flat color="primary" :label="t('app.retry')" @click="session.refresh()" />
  </div>
  <router-view v-else />
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useSessionStore } from '@/stores/session'

const session = useSessionStore()
const { t } = useI18n()
</script>
