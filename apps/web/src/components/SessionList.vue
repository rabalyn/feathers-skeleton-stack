<template>
  <q-list separator data-test="session-list">
    <q-item v-for="row in rows" :key="row.id" :data-session="row.id" :data-current="row.id === session.sessionId || undefined">
      <q-item-section avatar>
        <q-icon name="devices" />
      </q-item-section>
      <q-item-section>
        <q-item-label>
          <span :title="row.userAgent ?? undefined">{{ describeUserAgent(row.userAgent) ?? t('sessions.unknownBrowser') }}</span>
          <q-badge v-if="row.id === session.sessionId" color="primary" class="q-ml-sm" :label="t('sessions.current')" />
        </q-item-label>
        <q-item-label caption>
          {{ t('sessions.since', { date: dateTime(row.issuedAt) }) }} ·
          {{ t('sessions.lastUsed', { date: dateTime(row.lastUsedAt) }) }}
        </q-item-label>
      </q-item-section>
      <q-item-section side>
        <!-- This browser's own session ends with the logout, which also ends
             the session at the identity provider (ADR 0008, 0011). -->
        <q-btn
          v-if="row.id === session.sessionId"
          flat
          no-caps
          icon="logout"
          :label="t('auth.logout')"
          data-test="session-logout"
          @click="logout"
        />
        <q-btn
          v-else
          flat
          no-caps
          color="negative"
          icon="block"
          :label="t('sessions.revoke')"
          :loading="revoking === row.id"
          data-test="session-revoke"
          @click="revoke(row)"
        />
      </q-item-section>
    </q-item>
    <q-item v-if="!rows.length && !sessions.isPending">
      <q-item-section class="text-grey-7">{{ t('sessions.empty') }}</q-item-section>
    </q-item>
  </q-list>
</template>

<script setup lang="ts">
import type { Session } from '@app/api/client'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { describeUserAgent } from '@/api/user-agent'
import { useApi } from '@/boot/feathers'
import { useFormat } from '@/composables/format'
import { useNotify } from '@/composables/notify'
import { useSessionStore } from '@/stores/session'

// The caller's active sessions (ADR 0010, 0011): where they are logged in,
// and a way to end any of those logins but this one, which is a logout.

const props = defineProps<{ userId: string }>()

const api = useApi()
const session = useSessionStore()
const { t } = useI18n()
const { dateTime } = useFormat()
const notify = useNotify()

const params = computed(() => ({ query: { userId: props.userId, $sort: { lastUsedAt: -1 }, $limit: 50 } }))
const sessions = api.service('sessions').useFind(params, { paginateOn: 'server' })
const rows = computed(() => sessions.data as Session[])

const revoking = ref<string | null>(null)
const revoke = async (row: Session) => {
  revoking.value = row.id
  try {
    await api.service('sessions').remove(row.id)
    notify.success(t('sessions.revoked'))
  } catch (error) {
    notify.failure(error)
  } finally {
    revoking.value = null
  }
}

const logout = async () => {
  try {
    await session.logout()
  } catch (error) {
    notify.failure(error)
  }
}
</script>
