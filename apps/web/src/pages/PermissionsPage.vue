<template>
  <q-page padding>
    <div class="row items-center q-mb-md">
      <h1 class="text-h5 q-my-none col">{{ t('permissions.title') }}</h1>
      <q-btn color="primary" no-caps icon="add" :label="t('permissions.newRole')" @click="openCreate" />
    </div>
    <p class="text-body2 text-grey-8 intro">{{ t('permissions.intro') }}</p>

    <q-markup-table flat bordered separator="cell" wrap-cells class="grid">
      <thead>
        <tr>
          <th class="text-left permission">{{ t('permissions.permission') }}</th>
          <th v-for="role in roles" :key="role.id" class="text-center role">
            <div class="text-weight-medium">{{ name(role) }}</div>
            <div class="text-caption text-grey-7">{{ t(`permissions.${role.kind}`) }}</div>
            <div class="row justify-center no-wrap q-mt-xs">
              <q-btn
                flat
                dense
                round
                size="sm"
                icon="visibility"
                :aria-label="t('permissions.preview')"
                :title="t('permissions.preview')"
                @click="session.startPreview(role)"
              />
              <q-btn
                v-if="role.kind !== 'admin'"
                flat
                dense
                round
                size="sm"
                icon="edit"
                :aria-label="t('permissions.rename')"
                :title="t('permissions.rename')"
                @click="openRename(role)"
              />
              <q-btn
                v-if="role.kind === 'custom'"
                flat
                dense
                round
                size="sm"
                icon="delete"
                color="negative"
                :aria-label="t('permissions.delete')"
                :title="t('permissions.delete')"
                @click="confirmRemove(role)"
              />
            </div>
          </th>
        </tr>
      </thead>
      <tbody>
        <template v-for="group in groups" :key="group.name">
          <tr class="group">
            <td :colspan="roles.length + 1" class="text-weight-medium">{{ labels.group(group.name) }}</td>
          </tr>
          <tr v-for="key in group.keys" :key="key">
            <td>
              <div>{{ labels.label(key) }}</div>
              <div class="text-caption text-grey-7">{{ labels.description(key) }}</div>
            </td>
            <td v-for="role in roles" :key="role.id" class="text-center">
              <q-checkbox
                :model-value="granted(role, key)"
                :disable="role.kind === 'admin' || saving === role.id"
                :aria-label="`${name(role)}: ${labels.label(key)}`"
                @update:model-value="(value: boolean) => toggle(role, key, value)"
              />
            </td>
          </tr>
        </template>
      </tbody>
    </q-markup-table>

    <q-dialog v-model="editing">
      <q-card class="editor">
        <q-form @submit.prevent="save">
          <q-card-section>
            <div class="text-h6">{{ draft.id ? t('permissions.rename') : t('permissions.newRole') }}</div>
          </q-card-section>
          <q-card-section class="q-gutter-md">
            <q-input
              v-if="!draft.id"
              v-model="draft.key"
              outlined
              :label="t('permissions.key')"
              :hint="t('permissions.keyHint')"
              :rules="[(value: string) => KEY_PATTERN.test(value) || t('permissions.keyHint')]"
            />
            <q-input
              v-for="locale in LOCALES"
              :key="locale"
              v-model="draft.name[locale]"
              outlined
              maxlength="80"
              :label="t('permissions.name', { locale: t(`app.locales.${locale}`) })"
              :rules="[(value: string) => value.trim().length > 0 || t('permissions.name', { locale: t(`app.locales.${locale}`) })]"
            />
          </q-card-section>
          <q-card-actions align="right">
            <q-btn v-close-popup flat no-caps :label="t('permissions.cancel')" />
            <q-btn type="submit" color="primary" no-caps :label="t('permissions.save')" :loading="saving === 'draft'" />
          </q-card-actions>
        </q-form>
      </q-card>
    </q-dialog>
  </q-page>
</template>

<script setup lang="ts">
import { LOCALES, PERMISSIONS, type Locale, type Role } from '@app/api/client'
import { useQuasar } from 'quasar'
import { computed, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useApi } from '@/boot/feathers'
import { useNotify } from '@/composables/notify'
import { usePermissionLabels, useRoles } from '@/composables/roles'
import { useSessionStore } from '@/stores/session'

// Roles and what they grant (ADR 0011), admin only: the catalogue as rows,
// grouped as the API declares it, the roles as columns. `admin` is fixed and
// holds everything; `operator` and `user` are editable but stay.
const api = useApi()
const session = useSessionStore()
const $q = useQuasar()
const { t } = useI18n()
const notify = useNotify()
const labels = usePermissionLabels()
const { roles: all, name } = useRoles()

const KIND_ORDER = { admin: 0, seeded: 1, custom: 2 } as const
const roles = computed(() => [...all.value].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.key.localeCompare(b.key)))

const groups = computed(() => {
  const byGroup = new Map<string, string[]>()
  for (const entry of PERMISSIONS) byGroup.set(entry.group, [...(byGroup.get(entry.group) ?? []), entry.key])
  return [...byGroup].map(([group, keys]) => ({ name: group, keys }))
})

const granted = (role: Role, key: string) => role.kind === 'admin' || (role.permissions ?? []).includes(key)

// The role being written to: one change at a time per role, since a patch
// carries its full list of permissions.
const saving = ref<string | null>(null)

const toggle = async (role: Role, key: string, value: boolean) => {
  const current = role.permissions ?? []
  const permissions = value ? [...current, key] : current.filter((candidate) => candidate !== key)
  saving.value = role.id
  try {
    await api.service('roles').patch(role.id, { permissions })
    notify.success(t('permissions.saved'))
  } catch (error) {
    notify.failure(error)
  } finally {
    saving.value = null
  }
}

const KEY_PATTERN = /^[a-z][a-z0-9-]{1,39}$/
const editing = ref(false)
const draft = reactive<{ id: string | null; key: string; name: Record<Locale, string> }>({
  id: null,
  key: '',
  name: { de: '', en: '' }
})

const openCreate = () => {
  Object.assign(draft, { id: null, key: '', name: { de: '', en: '' } })
  editing.value = true
}

const openRename = (role: Role) => {
  Object.assign(draft, { id: role.id, key: role.key, name: { ...role.name } })
  editing.value = true
}

const save = async () => {
  saving.value = 'draft'
  const trimmed = Object.fromEntries(LOCALES.map((locale) => [locale, draft.name[locale].trim()])) as Record<Locale, string>
  try {
    if (draft.id) {
      await api.service('roles').patch(draft.id, { name: trimmed })
      notify.success(t('permissions.saved'))
    } else {
      await api.service('roles').create({ key: draft.key, name: trimmed, permissions: [] })
      notify.success(t('permissions.created'))
    }
    editing.value = false
  } catch (error) {
    notify.failure(error)
  } finally {
    saving.value = null
  }
}

const confirmRemove = (role: Role) => {
  $q.dialog({
    message: t('permissions.deleteConfirm', { name: name(role) }),
    cancel: { label: t('permissions.cancel'), flat: true, noCaps: true },
    ok: { label: t('permissions.delete'), color: 'negative', noCaps: true }
  }).onOk(() => void remove(role))
}

const remove = async (role: Role) => {
  try {
    await api.service('roles').remove(role.id)
    notify.success(t('permissions.deleted'))
  } catch (error) {
    // Still held by somebody (ADR 0011): say so rather than "not allowed".
    if ((error as { code?: number }).code === 409) $q.notify({ type: 'negative', message: t('permissions.assigned') })
    else notify.failure(error)
  }
}
</script>

<style scoped>
.intro {
  max-width: 72ch;
}
.grid .permission {
  min-width: 280px;
}
.grid .role {
  min-width: 120px;
  vertical-align: top;
}
.grid .group td {
  background: rgba(0, 0, 0, 0.04);
}
.editor {
  min-width: 360px;
}
</style>
