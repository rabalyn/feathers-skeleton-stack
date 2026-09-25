<template>
  <div class="fullscreen flex flex-center column q-gutter-md text-center">
    <div class="text-h2">404</div>
    <div class="text-h6">{{ t('errors.notFound') }}</div>
    <q-btn color="primary" :label="t('errors.home')" to="/" />
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
</script>
