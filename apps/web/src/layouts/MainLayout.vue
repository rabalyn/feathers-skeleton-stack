<template>
  <q-layout view="hHh lpR fFf">
    <q-header elevated>
      <q-toolbar>
        <q-btn flat dense round icon="menu" :aria-label="t('nav.menu')" @click="drawer = !drawer" />
        <q-toolbar-title>{{ t('app.title') }}</q-toolbar-title>
        <LocaleSwitch />
        <q-btn flat no-caps icon="account_circle" :label="displayName" :to="{ name: 'profile' }" />
        <q-btn flat no-caps icon="logout" :label="t('auth.logout')" @click="logout" />
      </q-toolbar>
      <q-banner v-if="session.unavailable" dense class="bg-warning text-dark" role="status">
        {{ t('auth.unavailable') }}
      </q-banner>
    </q-header>

    <q-drawer v-model="drawer" show-if-above bordered>
      <q-list>
        <q-item v-for="link in links" :key="link.name" clickable :to="{ name: link.name }">
          <q-item-section avatar><q-icon :name="link.icon" /></q-item-section>
          <q-item-section>{{ t(link.label) }}</q-item-section>
        </q-item>
      </q-list>
    </q-drawer>

    <q-page-container>
      <router-view />
    </q-page-container>
  </q-layout>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import LocaleSwitch from '@/components/LocaleSwitch.vue'
import { useNotify } from '@/composables/notify'
import { useSessionStore } from '@/stores/session'

const session = useSessionStore()
const { t } = useI18n()
const drawer = ref(false)
const notify = useNotify()

const logout = async () => {
  try {
    await session.logout()
  } catch (error) {
    notify.failure(error)
  }
}

const displayName = computed(() => {
  const user = session.user
  if (!user) return ''
  return [user.givenName, user.surname].filter(Boolean).join(' ') || user.tuId || ''
})

// Only what the user's role may open (ADR 0011).
const links = computed(() =>
  [
    { name: 'profile', icon: 'person', label: 'nav.profile' },
    { name: 'documents', icon: 'description', label: 'nav.documents' },
    { name: 'users', icon: 'group', label: 'nav.users', requires: ['read', 'users'] },
    { name: 'settings', icon: 'tune', label: 'nav.settings', requires: ['read', 'settings'] },
    { name: 'directory', icon: 'contact_page', label: 'nav.directory', requires: ['read', 'directory'] },
    { name: 'audit', icon: 'history', label: 'nav.audit', requires: ['read', 'audit-events'] },
    { name: 'gdpr', icon: 'privacy_tip', label: 'nav.gdpr', requires: ['create', 'erasures'] },
    { name: 'mail-templates', icon: 'mail', label: 'nav.mailTemplates', requires: ['read', 'mail-templates'] },
    { name: 'mailings', icon: 'campaign', label: 'nav.mailings', requires: ['create', 'mail-campaigns'] }
  ].filter((link) => !link.requires || session.canAll(link.requires[0]!, link.requires[1]!))
)
</script>
