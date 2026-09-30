<template>
  <div class="fullscreen flex flex-center bg-grey-2">
    <q-card class="maintenance-card">
      <q-card-section class="row items-center no-wrap q-gutter-md">
        <q-icon name="construction" size="lg" color="warning" />
        <div class="text-h5">{{ t('maintenance.title') }}</div>
      </q-card-section>
      <q-card-section>
        <p>{{ t('maintenance.body') }}</p>
        <p class="text-caption text-grey-8" role="status">
          {{ checkedAt ? t('maintenance.checked', { time: time(checkedAt) }) : t('maintenance.checking') }}
        </p>
      </q-card-section>
      <q-card-actions align="between">
        <LocaleSwitch />
        <q-btn flat no-caps :to="{ name: 'login' }" :label="t('maintenance.adminLogin')" />
      </q-card-actions>
    </q-card>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import LocaleSwitch from '@/components/LocaleSwitch.vue'
import { MAINTENANCE_POLL_MS, fetchMaintenanceState } from '@/api/maintenance'

// Maintenance mode (ADR 0025). The API may be down meanwhile, so the page
// asks the public state every 30 seconds; once the API answers that the
// mode is off, the whole application loads afresh at the login page, with
// a new socket and new stores. Those who may bypass maintenance log in
// through the login page as usual.
const { t, locale } = useI18n()
const time = (value: Date) => new Intl.DateTimeFormat(locale.value, { timeStyle: 'medium' }).format(value)

const checkedAt = ref<Date | null>(null)
let timer: ReturnType<typeof setInterval> | undefined

const check = async () => {
  const state = await fetchMaintenanceState()
  checkedAt.value = new Date()
  if (state === 'inactive') window.location.assign('/login')
}

onMounted(() => {
  void check()
  timer = setInterval(() => void check(), MAINTENANCE_POLL_MS)
})
onBeforeUnmount(() => clearInterval(timer))
</script>

<style scoped>
.maintenance-card {
  width: 100%;
  max-width: 480px;
}
</style>
