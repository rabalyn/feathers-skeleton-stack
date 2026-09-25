<template>
  <q-page padding>
    <h1 class="text-h5 q-mt-none">{{ t('nav.profile') }}</h1>
    <q-list v-if="user" bordered separator class="profile">
      <q-item v-for="field in fields" :key="field.label">
        <q-item-section>
          <q-item-label caption>{{ t(field.label) }}</q-item-label>
          <q-item-label :data-field="field.key">{{ field.value }}</q-item-label>
        </q-item-section>
      </q-item>
    </q-list>
  </q-page>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useFormat } from '@/composables/format'
import { useSessionStore } from '@/stores/session'

const session = useSessionStore()
const { t } = useI18n()
const { dateTime } = useFormat()

const user = computed(() => session.user)

// Directory fields come from the IdP and are refreshed on every login; the
// role is assigned here (ADR 0009, 0011). Nothing on this page is editable.
const fields = computed(() => {
  const current = user.value
  if (!current) return []
  return [
    { key: 'tuId', label: 'user.tuId', value: current.tuId },
    { key: 'givenName', label: 'user.givenName', value: current.givenName },
    { key: 'surname', label: 'user.surname', value: current.surname },
    { key: 'email', label: 'user.email', value: current.email },
    { key: 'role', label: 'user.role', value: t(`user.roles.${current.role}`) },
    { key: 'createdAt', label: 'user.createdAt', value: dateTime(current.createdAt) }
  ] as const
})
</script>

<style scoped>
.profile {
  max-width: 640px;
}
</style>
