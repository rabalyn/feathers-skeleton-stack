<template>
  <div class="fullscreen flex flex-center bg-grey-2">
    <q-card class="login-card">
      <q-card-section>
        <div class="text-h5">{{ t('app.title') }}</div>
      </q-card-section>
      <q-card-section>
        <q-banner v-if="session.expired" dense class="bg-orange-1 q-mb-md" role="status">
          {{ t('auth.expired') }}
        </q-banner>
        <p>{{ t('auth.welcome') }}</p>
      </q-card-section>
      <q-card-actions align="between">
        <LocaleSwitch />
        <q-btn color="primary" icon="login" :label="t('auth.login')" @click="session.login(returnTo)" />
      </q-card-actions>
    </q-card>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import LocaleSwitch from '@/components/LocaleSwitch.vue'
import { useSessionStore } from '@/stores/session'

const session = useSessionStore()
const route = useRoute()
const { t } = useI18n()

// The API accepts only same-origin paths and falls back to `/` (ADR 0008).
const returnTo = computed(() => (typeof route.query.returnTo === 'string' ? route.query.returnTo : '/'))
</script>

<style scoped>
.login-card {
  width: 100%;
  max-width: 420px;
}
</style>
