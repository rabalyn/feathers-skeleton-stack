<template>
  <q-page padding>
    <h1 class="text-h5 q-mt-none">{{ t('nav.mailings') }}</h1>

    <q-card flat bordered class="q-mb-lg">
      <q-card-section>
        <h2 class="text-h6 q-my-none">{{ t('mail.newCampaign') }}</h2>
      </q-card-section>
      <q-card-section class="column q-gutter-md">
        <q-select
          v-model="kindKey"
          :options="kindOptions"
          emit-value
          map-options
          outlined
          dense
          :label="t('mail.campaign')"
          data-test="mailing-kind"
          @update:model-value="choose"
        />
        <template v-for="field in fields" :key="field.name">
          <q-toggle v-if="field.input === 'boolean'" v-model="flags[field.name]" :label="field.label" />
          <q-select
            v-else-if="field.input === 'enum'"
            v-model="values[field.name]"
            :options="field.options"
            outlined
            dense
            :label="field.label"
          />
          <q-input
            v-else
            v-model="values[field.name]"
            outlined
            dense
            :type="field.input === 'number' ? 'number' : field.input === 'date' ? 'date' : 'text'"
            :stack-label="field.input === 'date'"
            :label="field.label"
            :data-test="`mailing-param-${field.name}`"
          />
        </template>
        <div>
          <q-btn
            outline
            color="primary"
            no-caps
            icon="visibility"
            :label="t('mail.previewCampaign')"
            :disable="!kindKey"
            :loading="previewing"
            data-test="mailing-preview"
            @click="preview"
          />
        </div>
      </q-card-section>

      <q-card-section v-if="previewed" data-test="mailing-previewed">
        <div class="text-subtitle1 text-weight-medium" data-test="mailing-recipients">
          {{ t('mail.recipients', { count: previewed.recipientCount }) }}
        </div>
        <div class="text-body2 q-mb-md">
          {{ previewed.estimatedSeconds ? t('mail.duration', { duration: duration(previewed.estimatedSeconds) }) : t('mail.durationNow') }}
        </div>
        <template v-if="previewed.previews && previewed.recipient">
          <div class="text-caption q-mb-sm">
            {{ t('mail.previewFor', { name: `${previewed.recipient.givenName} ${previewed.recipient.surname}` }) }}
          </div>
          <q-tabs v-model="previewLocale" dense align="left" no-caps class="text-primary">
            <q-tab v-for="each in LOCALES" :key="each" :name="each" :label="t(`app.locales.${each}`)" />
          </q-tabs>
          <MailPreview v-if="shown" :key="previewLocale" :mail="shown" />
          <q-btn class="q-mt-md" color="primary" no-caps icon="send" :label="t('mail.send')" data-test="mailing-send" @click="confirming = true" />
        </template>
        <p v-else class="text-body2">{{ t('mail.nobody') }}</p>
      </q-card-section>
    </q-card>

    <div class="row items-center q-mb-sm">
      <h2 class="text-h6 q-my-none col">{{ t('mail.campaigns') }}</h2>
      <q-btn flat dense round icon="refresh" :aria-label="t('mail.refresh')" @click="reload" />
    </div>
    <q-table :rows="campaigns" :columns="campaignColumns" row-key="id" flat bordered :pagination="{ rowsPerPage: 10 }" data-test="mailing-campaigns">
      <template #body-cell-progress="props">
        <q-td :props="props">{{ t('mail.progress', props.row.progress) }}</q-td>
      </template>
    </q-table>

    <div class="row items-center q-mt-lg q-mb-sm">
      <h2 class="text-h6 q-my-none col">{{ t('mail.deliveries') }}</h2>
      <q-select v-model="statusFilter" :options="statusOptions" emit-value map-options dense outlined class="filter" @update:model-value="loadDeliveries" />
    </div>
    <q-table :rows="deliveries" :columns="deliveryColumns" row-key="id" flat bordered :pagination="{ rowsPerPage: 25 }" data-test="mailing-deliveries" />

    <q-dialog v-model="confirming">
      <q-card class="confirm">
        <q-card-section>
          <h2 class="text-h6 q-my-none">{{ t('mail.confirmTitle') }}</h2>
          <p class="text-body2">
            {{ t('mail.confirmText', { count: previewed?.recipientCount ?? 0, duration: previewed?.estimatedSeconds ? duration(previewed.estimatedSeconds) : t('mail.durationNow') }) }}
          </p>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn v-close-popup flat no-caps :label="t('mail.cancel')" />
          <q-btn color="primary" no-caps :label="t('mail.send')" :loading="sending" data-test="mailing-confirm" @click="send" />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-page>
</template>

<script setup lang="ts">
import { LOCALES, type Locale, type MailCampaign, type MailCampaignPreview, type MailDelivery, type MailKindInfo } from '@app/api/client'
import type { QTableProps } from 'quasar'
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import MailPreview from '@/components/MailPreview.vue'
import { client } from '@/api/feathers'
import { useFormat } from '@/composables/format'
import { useMail, type JsonSchema } from '@/composables/mail'
import { useNotify } from '@/composables/notify'

// Mailings (ADR 0027), sent by an admin and only by hand (ADR 0011): pick a
// campaign, fill the parameters its code declares, see whom it reaches, how
// long it takes and how it reads for one of them, then send. Below, what was
// sent and how each delivery went.

const i18n = useI18n()
const { t } = i18n
const { dateTime } = useFormat()
const { kindLabel, paramLabel, duration } = useMail()
const notify = useNotify()

const kinds = ref<MailKindInfo[]>([])
const kindKey = ref<string | null>(null)
const kindOptions = computed(() => kinds.value.map((kind) => ({ value: kind.key, label: kindLabel(kind.key) })))
// Switches apart from everything typed or chosen.
const values = reactive<Record<string, string | number | null>>({})
const flags = reactive<Record<string, boolean>>({})

// The form follows the kind's params schema: text, numbers, dates, switches
// and choices, which is all a campaign may ask for.
interface Field {
  name: string
  label: string
  input: 'text' | 'number' | 'date' | 'boolean' | 'enum'
  options?: string[]
}
const fields = computed<Field[]>(() => {
  const kind = kinds.value.find((each) => each.key === kindKey.value)
  const properties = (kind?.params as JsonSchema | undefined)?.properties ?? {}
  return Object.entries(properties).map(([name, schema]) => {
    const label = paramLabel(kind!.key, name)
    if (schema.anyOf) return { name, label, input: 'enum', options: schema.anyOf.map((each) => String(each.const)) }
    if (schema.type === 'boolean') return { name, label, input: 'boolean' }
    if (schema.type === 'integer' || schema.type === 'number') return { name, label, input: 'number' }
    if (schema.format === 'date') return { name, label, input: 'date' }
    return { name, label, input: 'text' }
  })
})

const choose = () => {
  previewed.value = null
  for (const key of Object.keys(values)) delete values[key]
  for (const key of Object.keys(flags)) delete flags[key]
  const kind = kinds.value.find((each) => each.key === kindKey.value)
  for (const [name, schema] of Object.entries((kind?.params as JsonSchema | undefined)?.properties ?? {})) {
    if (schema.type === 'boolean') flags[name] = schema.default === true
    else if (typeof schema.default === 'string' || typeof schema.default === 'number') values[name] = schema.default
  }
}

// Number inputs hand back text; the schema wants numbers.
const params = () => {
  const typed: Record<string, unknown> = {}
  for (const field of fields.value) {
    if (field.input === 'boolean') {
      typed[field.name] = flags[field.name] ?? false
      continue
    }
    const value = values[field.name]
    if (value === undefined || value === '') continue
    typed[field.name] = field.input === 'number' ? Number(value) : value
  }
  return typed
}

const previewing = ref(false)
const previewed = ref<MailCampaignPreview | null>(null)
const previewLocale = ref<Locale>('de')
const shown = computed(() => previewed.value?.previews?.[previewLocale.value])
const preview = async () => {
  if (!kindKey.value) return
  previewing.value = true
  try {
    previewed.value = await client.service('mail-campaign-previews').create({ kind: kindKey.value, params: params() })
  } catch (error) {
    previewed.value = null
    notify.failure(error)
  } finally {
    previewing.value = false
  }
}

const confirming = ref(false)
const sending = ref(false)
const send = async () => {
  if (!kindKey.value) return
  sending.value = true
  try {
    await client.service('mail-campaigns').create({ kind: kindKey.value, params: params() })
    confirming.value = false
    previewed.value = null
    notify.success(t('mail.sent'))
    await reload()
  } catch (error) {
    notify.failure(error)
  } finally {
    sending.value = false
  }
}

const campaigns = ref<MailCampaign[]>([])
const campaignColumns = computed<NonNullable<QTableProps['columns']>>(() => [
  { name: 'createdAt', field: 'createdAt', label: t('mail.sentAt'), align: 'left', format: (value: string) => dateTime(value) },
  { name: 'kind', field: 'kind', label: t('mail.campaign'), align: 'left', format: (value: string) => kindLabel(value) },
  { name: 'sentBy', field: 'sentBy', label: t('mail.sentBy'), align: 'left', format: (value: string) => person(value) },
  { name: 'status', field: 'status', label: t('mail.status'), align: 'left', format: (value: string) => t(`mail.statuses.${value}`) },
  { name: 'recipientCount', field: 'recipientCount', label: t('mail.recipient'), align: 'right' },
  { name: 'progress', field: 'progress', label: '', align: 'left' }
])

const statusFilter = ref<string | null>(null)
const statusOptions = computed(() => [
  { value: null, label: t('mail.allStatuses') },
  ...(['pending', 'sent', 'failed', 'skipped'] as const).map((status) => ({ value: status, label: t(`mail.statuses.${status}`) }))
])
const deliveries = ref<MailDelivery[]>([])
const reason = (row: MailDelivery) =>
  row.skipReason ? (i18n.te(`mail.reasons.${row.skipReason}`) ? t(`mail.reasons.${row.skipReason}`) : row.skipReason) : (row.error ?? '')
const deliveryColumns = computed<NonNullable<QTableProps['columns']>>(() => [
  { name: 'createdAt', field: 'createdAt', label: t('mail.createdAt'), align: 'left', format: (value: string) => dateTime(value) },
  { name: 'kind', field: 'kind', label: t('mail.kind'), align: 'left', format: (value: string) => kindLabel(value) },
  { name: 'userId', field: 'userId', label: t('mail.recipient'), align: 'left', format: (value: string) => person(value) },
  { name: 'status', field: 'status', label: t('mail.status'), align: 'left', format: (value: string) => t(`mail.statuses.${value}`) },
  { name: 'detail', field: (row: MailDelivery) => reason(row), label: t('mail.detail'), align: 'left' }
])

// People by surrogate id, as the admin may read them.
const names = reactive(new Map<string, string>())
const person = (id: string) => names.get(id) ?? id.slice(0, 8)
const resolve = async (ids: string[]) => {
  const missing = [...new Set(ids)].filter((id) => !names.has(id))
  if (!missing.length) return
  const found = await client.service('users').find({ query: { id: { $in: missing }, $limit: missing.length } })
  for (const user of found.data) names.set(user.id, [user.givenName, user.surname].filter(Boolean).join(' ') || (user.tuId ?? user.id))
}

const loadDeliveries = async () => {
  try {
    const page = await client
      .service('mail-deliveries')
      .find({ query: { $limit: 100, ...(statusFilter.value ? { status: statusFilter.value as MailDelivery['status'] } : {}) } })
    deliveries.value = page.data
    await resolve(page.data.map((row) => row.userId))
  } catch (error) {
    notify.failure(error)
  }
}

const reload = async () => {
  try {
    const page = await client.service('mail-campaigns').find({ query: { $limit: 50 } })
    campaigns.value = page.data
    await resolve(page.data.map((row) => row.sentBy))
  } catch (error) {
    notify.failure(error)
  }
  await loadDeliveries()
}

// While a campaign is being sent, its progress is fetched again now and then.
let timer: ReturnType<typeof setInterval> | undefined
onMounted(async () => {
  try {
    kinds.value = (await client.service('mail-kinds').find()).filter((kind) => kind.type === 'campaign')
  } catch (error) {
    notify.failure(error)
  }
  await reload()
  timer = setInterval(() => {
    if (campaigns.value.some((campaign) => campaign.status === 'pending' || campaign.progress.pending > 0)) void reload()
  }, 10_000)
})
onUnmounted(() => clearInterval(timer))
</script>

<style scoped>
.confirm {
  width: 100%;
  max-width: 520px;
}
.filter {
  min-width: 180px;
}
</style>
