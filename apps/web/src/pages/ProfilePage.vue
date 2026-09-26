<template>
  <q-page padding>
    <h1 class="text-h5 q-mt-none">{{ t('nav.profile') }}</h1>
    <div v-if="user" class="profile column q-gutter-md">
      <q-card flat bordered>
        <q-card-section class="row items-center q-gutter-md">
          <q-avatar size="96px" color="grey-4" text-color="grey-8" data-test="avatar">
            <img v-if="avatarUrl" :src="avatarUrl" :alt="t('avatar.title')" />
            <q-icon v-else name="person" />
          </q-avatar>
          <div class="column q-gutter-sm">
            <q-file
              v-model="picked"
              :accept="AVATAR_CONTENT_TYPES.join(',')"
              :label="t('avatar.upload')"
              :hint="t('avatar.hint')"
              :loading="busy"
              dense
              outlined
              data-test="avatar-input"
              @update:model-value="setAvatar"
            />
            <q-btn
              v-if="user.avatarFileId"
              flat
              no-caps
              color="negative"
              :label="t('avatar.remove')"
              :disable="busy"
              @click="clearAvatar"
            />
          </div>
        </q-card-section>
      </q-card>
      <q-list bordered separator>
        <q-item v-for="field in fields" :key="field.label">
          <q-item-section>
            <q-item-label caption>{{ t(field.label) }}</q-item-label>
            <q-item-label :data-field="field.key">{{ field.value }}</q-item-label>
          </q-item-section>
        </q-item>
      </q-list>
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { AVATAR_CONTENT_TYPES } from '@app/api/client'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { uploadFile } from '@/api/files'
import { client } from '@/api/feathers'
import { useAvatarUrl } from '@/composables/avatar'
import { useFormat } from '@/composables/format'
import { useNotify } from '@/composables/notify'
import { useSessionStore } from '@/stores/session'

const session = useSessionStore()
const { t } = useI18n()
const { dateTime } = useFormat()
const notify = useNotify()

const user = computed(() => session.user)
const avatarUrl = useAvatarUrl(computed(() => user.value?.avatarFileId))

const picked = ref<File | null>(null)
const busy = ref(false)

// Upload first, then attach it as the avatar of the caller's own record
// (ADR 0020). The record's event brings the new avatar to the session.
const setAvatar = async (file: File | null) => {
  if (!file) return
  busy.value = true
  try {
    const stored = await uploadFile(file)
    await client.service('avatars').create({ fileId: stored.id })
    notify.success(t('avatar.saved'))
  } catch (error) {
    notify.failure(error)
  } finally {
    busy.value = false
    picked.value = null
  }
}

const clearAvatar = async () => {
  busy.value = true
  try {
    await client.service('avatars').create({ fileId: null })
    notify.success(t('avatar.removed'))
  } catch (error) {
    notify.failure(error)
  } finally {
    busy.value = false
  }
}

// Directory fields come from the IdP and are refreshed on every login; the
// role is assigned here (ADR 0009, 0011). Only the picture is the user's.
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
