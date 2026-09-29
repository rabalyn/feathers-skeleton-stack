<template>
  <q-page padding>
    <h1 class="text-h5 q-mt-none">{{ t('nav.gdpr') }}</h1>
    <p class="text-body2 gdpr">{{ t('gdpr.explain') }}</p>

    <q-form class="gdpr row items-start q-gutter-sm q-mb-md" @submit="lookUp">
      <q-input
        v-model="tuId"
        :label="t('user.tuId')"
        dense
        outlined
        autocomplete="off"
        class="col-grow"
        data-test="gdpr-tu-id"
      />
      <q-btn type="submit" color="primary" no-caps :label="t('gdpr.lookUp')" :loading="searching" data-test="gdpr-look-up" />
    </q-form>

    <p v-if="notFound" class="text-body2" data-test="gdpr-not-found">{{ t('gdpr.notFound') }}</p>

    <div v-if="person" class="gdpr column q-gutter-md" data-test="gdpr-person">
      <q-list bordered separator>
        <q-item v-for="field in fields" :key="field.key">
          <q-item-section>
            <q-item-label caption>{{ t(field.label) }}</q-item-label>
            <q-item-label :data-field="field.key">{{ field.value }}</q-item-label>
          </q-item-section>
        </q-item>
      </q-list>

      <q-card flat bordered>
        <q-card-section>
          <h2 class="text-h6 q-my-none">{{ t('gdpr.exportTitle') }}</h2>
          <p class="text-body2 q-mb-none">{{ t('gdpr.exportExplain') }}</p>
        </q-card-section>
        <q-card-section>
          <DataExports :subject-id="person.id" />
        </q-card-section>
      </q-card>

      <q-card flat bordered class="erase">
        <q-card-section>
          <h2 class="text-h6 q-my-none">{{ t('gdpr.eraseTitle') }}</h2>
          <p class="text-body2">{{ t('gdpr.eraseExplain') }}</p>
          <p v-if="refusal" class="text-body2 text-weight-medium" data-test="gdpr-erase-refused">{{ refusal }}</p>
          <q-btn
            v-else
            color="negative"
            no-caps
            icon="delete_forever"
            :label="t('gdpr.erase')"
            data-test="gdpr-erase"
            @click="confirmErase"
          />
        </q-card-section>
      </q-card>
    </div>

    <q-dialog v-model="confirming">
      <q-card class="confirm">
        <q-card-section>
          <h2 class="text-h6 q-my-none">{{ t('gdpr.confirmTitle') }}</h2>
          <p class="text-body2">{{ t('gdpr.confirmText', { tuId: person?.tuId }) }}</p>
          <q-input v-model="typed" :label="t('user.tuId')" dense outlined autofocus autocomplete="off" data-test="gdpr-confirm-input" />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn v-close-popup flat no-caps :label="t('gdpr.cancel')" />
          <q-btn
            color="negative"
            no-caps
            :label="t('gdpr.erase')"
            :disable="typed.trim() !== person?.tuId"
            :loading="erasing"
            data-test="gdpr-confirm"
            @click="erase"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-page>
</template>

<script setup lang="ts">
import type { User } from '@app/api/client'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import DataExports from '@/components/DataExports.vue'
import { client } from '@/api/feathers'
import { useApi } from '@/boot/feathers'
import { useFormat } from '@/composables/format'
import { useNotify } from '@/composables/notify'
import { useRoles } from '@/composables/roles'
import { useSessionStore } from '@/stores/session'

// Data subject requests, for admins (ADR 0011, 0013): find the person by
// TU-ID, export their data for handing over, or erase them. Erasure cannot
// be undone, so it asks for the TU-ID to be typed once more.

const api = useApi()
const session = useSessionStore()
const { t } = useI18n()
const { dateTime } = useFormat()
const notify = useNotify()
const { namesOf } = useRoles()

const tuId = ref('')
const searching = ref(false)
const notFound = ref(false)
const person = ref<User | null>(null)

const lookUp = async () => {
  const wanted = tuId.value.trim()
  if (!wanted) return
  searching.value = true
  notFound.value = false
  person.value = null
  try {
    const found = await api.service('users').find({ query: { tuId: wanted, $limit: 1 } })
    person.value = (found.data[0] as User | undefined) ?? null
    notFound.value = !person.value
  } catch (error) {
    notify.failure(error)
  } finally {
    searching.value = false
  }
}

const fields = computed(() => {
  const current = person.value
  if (!current) return []
  return [
    { key: 'tuId', label: 'user.tuId', value: current.tuId },
    { key: 'givenName', label: 'user.givenName', value: current.givenName },
    { key: 'surname', label: 'user.surname', value: current.surname },
    { key: 'email', label: 'user.email', value: current.email },
    { key: 'role', label: 'user.role', value: namesOf(current.roleIds) },
    { key: 'createdAt', label: 'user.createdAt', value: dateTime(current.createdAt) }
  ] as const
})

// What the server refuses anyway, said before anybody tries.
const refusal = computed(() => {
  if (!person.value) return ''
  if (person.value.id === session.user?.id) return t('gdpr.notSelf')
  if (person.value.authSource === 'local') return t('gdpr.notBreakGlass')
  return ''
})

const confirming = ref(false)
const typed = ref('')
const erasing = ref(false)

const confirmErase = () => {
  typed.value = ''
  confirming.value = true
}

const erase = async () => {
  if (!person.value) return
  erasing.value = true
  try {
    // Not a stored record: straight through the client, not a service store.
    await client.service('erasures').create({ userId: person.value.id })
    notify.success(t('gdpr.erased'))
    confirming.value = false
    person.value = null
    tuId.value = ''
  } catch (error) {
    notify.failure(error)
  } finally {
    erasing.value = false
  }
}
</script>

<style scoped>
.gdpr {
  max-width: 720px;
}
.confirm {
  min-width: 320px;
}
</style>
