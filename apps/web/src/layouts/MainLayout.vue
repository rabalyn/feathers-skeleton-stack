<template>
  <q-layout view="hHh lpR fFf">
    <q-header elevated>
      <q-toolbar>
        <q-btn flat dense round icon="menu" :aria-label="t('nav.menu')" @click="drawer = !drawer" />
        <q-toolbar-title>{{ productName }}</q-toolbar-title>
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
        <!-- Outside the items, so the links stay the drawer's only items. -->
        <div v-if="canArrange" class="row items-center no-wrap q-pr-sm">
          <q-item-label header class="col">{{ t(arranging ? 'nav.arranging' : 'nav.title') }}</q-item-label>
          <q-btn
            flat
            dense
            round
            size="sm"
            :icon="arranging ? 'check' : 'edit'"
            :aria-label="t(arranging ? 'nav.done' : 'nav.arrange')"
            :aria-pressed="arranging"
            data-testid="nav-arrange"
            @click="arranging = !arranging"
          />
        </div>
        <template v-if="arranging">
          <q-item
            v-for="(link, index) in arranged"
            :key="link.name"
            draggable="true"
            class="nav-arrange-item"
            :class="{ 'nav-drop-target': dropIndex === index && dragIndex !== index }"
            :data-testid="`nav-item-${link.name}`"
            @dragstart="dragStart($event, index)"
            @dragover.prevent="dropIndex = index"
            @dragleave="dropIndex = dropIndex === index ? null : dropIndex"
            @drop.prevent="drop(index)"
            @dragend="dragIndex = dropIndex = null"
          >
            <q-item-section avatar><q-icon name="drag_indicator" /></q-item-section>
            <q-item-section>{{ t(link.label) }}</q-item-section>
            <q-item-section side class="row no-wrap">
              <q-btn
                flat
                dense
                round
                size="sm"
                icon="arrow_upward"
                :disable="index === 0"
                :aria-label="t('nav.moveUp', { name: t(link.label) })"
                @click="move(index, index - 1)"
              />
              <q-btn
                flat
                dense
                round
                size="sm"
                icon="arrow_downward"
                :disable="index === arranged.length - 1"
                :aria-label="t('nav.moveDown', { name: t(link.label) })"
                @click="move(index, index + 1)"
              />
            </q-item-section>
          </q-item>
          <q-item>
            <q-item-section>
              <q-btn flat dense no-caps icon="restart_alt" :label="t('nav.reset')" data-testid="nav-reset" @click="reset" />
            </q-item-section>
          </q-item>
        </template>
        <template v-else>
          <q-item v-for="link in arranged" :key="link.name" clickable :to="{ name: link.name }" :data-testid="`nav-item-${link.name}`">
            <q-item-section avatar><q-icon :name="link.icon" /></q-item-section>
            <q-item-section>{{ t(link.label) }}</q-item-section>
          </q-item>
        </template>
      </q-list>
    </q-drawer>

    <q-page-container>
      <router-view />
    </q-page-container>
  </q-layout>
</template>

<script setup lang="ts">
import type { Locale, Role } from '@app/api/client'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import LocaleSwitch from '@/components/LocaleSwitch.vue'
import { useNavOrder } from '@/composables/nav-order'
import { arrange, moved } from '@/composables/order'
import { useNotify } from '@/composables/notify'
import { useSessionStore } from '@/stores/session'

const session = useSessionStore()
const { t, locale } = useI18n()

// The product's display name (ADR 0035), from product.env at build time.
const productName = import.meta.env.PRODUCT_DISPLAY_NAME
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
    { name: 'sites', icon: 'location_city', label: 'nav.sites', requires: ['read', 'sites'] },
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
    { name: 'queues', icon: 'pending_actions', label: 'nav.queues', requires: ['read', 'queues'] },
    { name: 'system-info', icon: 'system_update', label: 'nav.systemInfo', requires: ['read', 'system-info'] },
    { name: 'docs', icon: 'menu_book', label: 'nav.docs', requires: ['read', 'docs'] }
  ].filter(
    (link) =>
      (!link.requires || session.canAll(link.requires[0]!, link.requires[1]!)) &&
      (!link.requiresSome || session.can(link.requiresSome[0]!, link.requiresSome[1]!)) &&
      (!link.requiresAny || link.requiresAny.some(([action, subject]) => session.canAll(action!, subject!)))
  )
)

// The person's own order (decided 2026-10-02, ADR 0014): arranged in place,
// with buttons or by dragging, and stored at once. Not while viewing as
// somebody or previewing a role: the order is the person's own.
const navOrder = useNavOrder()
const arranging = ref(false)
const canArrange = computed(() => !session.viewAs && !session.preview && session.can('create', 'preferences'))
const arranged = computed(() => arrange(links.value, navOrder.order()))

const move = (from: number, to: number) => {
  const names = arranged.value.map((link) => link.name)
  void navOrder.save(moved(names, from, to))
}

const reset = () => void navOrder.reset()

const dragIndex = ref<number | null>(null)
const dropIndex = ref<number | null>(null)
const dragStart = (event: DragEvent, index: number) => {
  dragIndex.value = index
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    // Firefox starts a drag only with data set.
    event.dataTransfer.setData('text/plain', arranged.value[index]?.name ?? '')
  }
}
const drop = (index: number) => {
  if (dragIndex.value !== null && dragIndex.value !== index) move(dragIndex.value, index)
  dragIndex.value = dropIndex.value = null
}

watch(canArrange, (allowed) => {
  if (!allowed) arranging.value = false
})
</script>

<style scoped>
.nav-arrange-item {
  cursor: grab;
}
.nav-drop-target {
  box-shadow: inset 0 2px 0 var(--q-primary);
}
</style>
