<template>
  <q-page padding>
    <h1 class="text-h5 q-mt-none">{{ t('nav.settings') }}</h1>
    <q-card v-if="mayPatch && maintenance" flat bordered class="q-mb-md">
      <q-card-section class="row items-center q-gutter-md">
        <q-icon name="construction" size="md" :color="maintenance.value === true ? 'negative' : 'grey-7'" />
        <div class="col">
          <div class="text-subtitle1">{{ t('maintenance.setting') }}</div>
          <div class="text-caption text-grey-8">
            {{ maintenance.value === true ? t('maintenance.isOn') : t('maintenance.isOff') }}
          </div>
        </div>
        <q-btn
          :color="maintenance.value === true ? 'primary' : 'negative'"
          :label="maintenance.value === true ? t('maintenance.disable') : t('maintenance.enable')"
          @click="confirmingMaintenance = true"
        />
      </q-card-section>
    </q-card>
    <q-table
      :rows="settings.data"
      :columns="columns"
      row-key="key"
      :loading="settings.isPending"
      :pagination="{ rowsPerPage: 0 }"
      hide-pagination
      flat
      bordered
    >
      <template #body-cell-value="props">
        <q-td :props="props">
          <code class="value">{{ show(props.row.value) }}</code>
        </q-td>
      </template>
      <template #body-cell-actions="props">
        <q-td :props="props">
          <q-btn
            v-if="mayPatch && props.row.key !== MAINTENANCE_KEY"
            flat
            dense
            round
            icon="edit"
            :aria-label="t('settings.edit')"
            @click="edit(props.row)"
          />
        </q-td>
      </template>
    </q-table>

    <q-dialog v-model="editing">
      <q-card class="editor">
        <q-card-section>
          <div class="text-h6">{{ draftKey }}</div>
        </q-card-section>
        <q-card-section>
          <q-input
            v-model="draft"
            type="textarea"
            autogrow
            outlined
            :label="t('settings.value')"
            :error="draftError !== null"
            :error-message="draftError ?? undefined"
            input-class="value"
          />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn v-close-popup flat :label="t('settings.cancel')" />
          <q-btn color="primary" :label="t('settings.save')" :loading="saving" :disable="draftError !== null" @click="save" />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <q-dialog v-model="confirmingMaintenance">
      <q-card class="editor">
        <q-card-section>
          <div class="text-h6">
            {{ maintenance?.value === true ? t('maintenance.confirmDisableTitle') : t('maintenance.confirmEnableTitle') }}
          </div>
        </q-card-section>
        <q-card-section>
          {{ maintenance?.value === true ? t('maintenance.confirmDisable') : t('maintenance.confirmEnable') }}
        </q-card-section>
        <q-card-actions align="right">
          <q-btn v-close-popup flat :label="t('settings.cancel')" />
          <q-btn
            :color="maintenance?.value === true ? 'primary' : 'negative'"
            :label="maintenance?.value === true ? t('maintenance.disable') : t('maintenance.enable')"
            :loading="saving"
            @click="toggleMaintenance"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-page>
</template>

<script setup lang="ts">
import type { Setting } from '@app/api/client'
import type { QTableProps } from 'quasar'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useApi } from '@/boot/feathers'
import { useFormat } from '@/composables/format'
import { useNotify } from '@/composables/notify'
import { useSessionStore } from '@/stores/session'

// Runtime settings (ADR 0025), for admins only (ADR 0011). Each
// value is JSON whose shape depends on the key; the API validates it against
// the registry and the cross-setting rules and says what is wrong.
const api = useApi()
const session = useSessionStore()
const { t } = useI18n()
const { dateTime } = useFormat()
const notify = useNotify()

const mayPatch = computed(() => session.canAll('patch', 'settings'))

// Every key on one page: the registry is short.
const settings = api.service('settings').useFind(computed(() => ({ query: { $sort: { key: 1 }, $limit: 100 } })), {
  paginateOn: 'server'
})

const columns = computed<NonNullable<QTableProps['columns']>>(() => [
  { name: 'key', field: 'key', label: t('settings.key'), align: 'left' },
  { name: 'value', field: 'value', label: t('settings.value'), align: 'left' },
  {
    name: 'updatedAt',
    field: 'updatedAt',
    label: t('settings.updatedAt'),
    align: 'left',
    format: (value: Setting['updatedAt']) => dateTime(value)
  },
  { name: 'actions', field: 'key', label: '', align: 'right' }
])

const show = (value: unknown) => JSON.stringify(value)

// Maintenance mode has a switch of its own, with a confirmation, rather than
// the JSON editor: switching it on ends everyone else's sessions (ADR 0025).
const MAINTENANCE_KEY = 'maintenanceMode'
const maintenance = computed(() => (settings.data as Setting[]).find((setting) => setting.key === MAINTENANCE_KEY))
const confirmingMaintenance = ref(false)
const toggleMaintenance = async () => {
  saving.value = true
  try {
    await api.service('settings').patch(MAINTENANCE_KEY, { value: maintenance.value?.value !== true })
    notify.success(t('settings.saved'))
    confirmingMaintenance.value = false
  } catch (error) {
    notify.failure(error)
  } finally {
    saving.value = false
  }
}

const editing = ref(false)
const saving = ref(false)
const draftKey = ref('')
const draft = ref('')
const draftError = computed(() => {
  try {
    JSON.parse(draft.value)
    return null
  } catch {
    return t('settings.invalidJson')
  }
})

const edit = (setting: Setting) => {
  draftKey.value = setting.key
  draft.value = JSON.stringify(setting.value, null, 2)
  editing.value = true
}

const save = async () => {
  saving.value = true
  try {
    await api.service('settings').patch(draftKey.value, { value: JSON.parse(draft.value) as unknown })
    notify.success(t('settings.saved'))
    editing.value = false
  } catch (error) {
    notify.failure(error)
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.value {
  font-family: ui-monospace, monospace;
  white-space: pre-wrap;
}
.editor {
  width: 100%;
  max-width: 560px;
}
</style>
