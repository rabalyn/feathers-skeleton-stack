<template>
  <div class="fullscreen flex flex-center bg-grey-2">
    <q-card class="login-card">
      <q-form @submit="submit">
        <q-card-section>
          <h1 class="text-h5 q-my-none">{{ t('auth.breakGlass.title') }}</h1>
        </q-card-section>
        <q-card-section class="q-gutter-md">
          <p class="q-mb-none">{{ t('auth.breakGlass.hint') }}</p>
          <q-banner v-if="problem" dense class="bg-red-1" role="alert">
            {{ t(`auth.breakGlass.${problem}`) }}
          </q-banner>
          <q-input
            v-model="email"
            type="email"
            autocomplete="username"
            :label="t('auth.breakGlass.email')"
            outlined
            required
            autofocus
          />
          <q-input
            v-model="password"
            type="password"
            autocomplete="current-password"
            :label="t('auth.breakGlass.password')"
            outlined
            required
          />
        </q-card-section>
        <q-card-actions align="between">
          <LocaleSwitch />
          <q-btn type="submit" color="primary" icon="login" :label="t('auth.breakGlass.submit')" :loading="busy" />
        </q-card-actions>
      </q-form>
    </q-card>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import LocaleSwitch from '@/components/LocaleSwitch.vue'
import { useSessionStore } from '@/stores/session'

// The break-glass login (ADR 0008), for when the SAML login is unavailable.
// Deliberately not linked from the login page.

const session = useSessionStore()
const router = useRouter()
const { t } = useI18n()

const email = ref('')
const password = ref('')
const busy = ref(false)
const problem = ref<'invalid' | 'limited' | 'unavailable' | null>(null)

const submit = async () => {
  busy.value = true
  problem.value = null
  try {
    const outcome = await session.passwordLogin(email.value, password.value)
    if (outcome === 'ok') {
      await router.replace('/')
      return
    }
    problem.value = outcome
    password.value = ''
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.login-card {
  width: 100%;
  max-width: 420px;
}
</style>
