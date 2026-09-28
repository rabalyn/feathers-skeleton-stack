<template>
  <q-btn-dropdown flat dense no-caps icon="translate" :label="t(`app.locales.${locale}`)" :aria-label="t('app.language')">
    <q-list>
      <q-item v-for="option in LOCALES" :key="option" v-close-popup clickable :active="option === locale" @click="setLocale(option)">
        <q-item-section>{{ t(`app.locales.${option}`) }}</q-item-section>
      </q-item>
    </q-list>
  </q-btn-dropdown>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { setLocale } from '@/boot/i18n'
import { LOCALES } from '@/i18n'

const { t, locale } = useI18n()
</script>
