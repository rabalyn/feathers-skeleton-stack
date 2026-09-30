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
      <q-banner v-if="session.maintenanceOn" dense class="bg-red-8 text-white" role="status">
        {{ t('maintenance.banner') }}
      </q-banner>
      <q-banner v-if="session.unavailable" dense class="bg-warning text-dark" role="status">
        {{ t('auth.unavailable') }}
      </q-banner>
      <q-banner v-if="session.viewAs" dense class="bg-deep-orange-8 text-white" role="status">
        {{ t('viewAs.banner', { who: session.user?.tuId ?? '', until: time(session.viewAs.expiresAt) }) }}
        <template #action>
          <q-btn flat no-caps color="white" :label="t('viewAs.stop')" @click="endViewAs" />
        </template>
      </q-banner>
      <q-banner v-if="session.preview" dense class="bg-info text-white" role="status">
        {{ t('permissions.previewing', { name: name(session.preview.role) }) }}
        <template #action>
          <q-btn flat no-caps color="white" :label="t('permissions.endPreview')" @click="endPreview" />
        </template>
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
import type { Locale, Role } from '@app/api/client'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import LocaleSwitch from '@/components/LocaleSwitch.vue'
import { useNotify } from '@/composables/notify'
import { useSessionStore } from '@/stores/session'

const session = useSessionStore()
const { t, locale } = useI18n()
const router = useRouter()

const name = (role: Role) => role.name[locale.value as Locale] ?? role.key
const time = (value: string) => new Intl.DateTimeFormat(locale.value, { timeStyle: 'short' }).format(new Date(value))

// Back to the users page the view-as was started from.
const endViewAs = async () => {
  try {
    await session.endViewAs()
    void router.push({ name: 'users' })
  } catch (error) {
    notify.failure(error)
  }
}

// Back to the permissions page the preview was started from.
const endPreview = () => {
  session.endPreview()
  void router.push({ name: 'permissions' })
}
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

// Only what the user's roles may open, or the previewed role's (ADR 0011).
const links = computed(() =>
  [
    { name: 'profile', icon: 'person', label: 'nav.profile' },
    { name: 'documents', icon: 'description', label: 'nav.documents', requiresSome: ['read', 'documents'] },
    { name: 'users', icon: 'group', label: 'nav.users', requires: ['read', 'users'] },
    { name: 'permissions', icon: 'admin_panel_settings', label: 'nav.permissions', requires: ['create', 'roles'] },
    { name: 'settings', icon: 'tune', label: 'nav.settings', requires: ['read', 'settings'] },
    { name: 'directory', icon: 'contact_page', label: 'nav.directory', requires: ['read', 'directory'] },
    { name: 'sessions', icon: 'devices', label: 'nav.sessions', requires: ['read', 'sessions'] },
    {
      name: 'api-tokens',
      icon: 'key',
      label: 'nav.apiTokens',
      requiresAny: [
        ['create', 'api-tokens'],
        ['read', 'api-tokens']
      ]
    },
    { name: 'audit', icon: 'history', label: 'nav.audit', requires: ['read', 'audit-events'] },
    { name: 'gdpr', icon: 'privacy_tip', label: 'nav.gdpr', requires: ['create', 'erasures'] },
    { name: 'mail-templates', icon: 'mail', label: 'nav.mailTemplates', requires: ['read', 'mail-templates'] },
    { name: 'mailings', icon: 'campaign', label: 'nav.mailings', requires: ['create', 'mail-campaigns'] },
    { name: 'queues', icon: 'pending_actions', label: 'nav.queues', requires: ['read', 'queues'] }
  ].filter(
    (link) =>
      (!link.requires || session.canAll(link.requires[0]!, link.requires[1]!)) &&
      (!link.requiresSome || session.can(link.requiresSome[0]!, link.requiresSome[1]!)) &&
      (!link.requiresAny || link.requiresAny.some(([action, subject]) => session.canAll(action!, subject!)))
  )
)
</script>
