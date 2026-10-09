<template>
  <q-page padding>
    <h1 class="text-h5 q-mt-none">{{ t('nav.mailTemplates') }}</h1>
    <div class="row q-col-gutter-md">
      <div class="col-12 col-md-3">
        <q-list bordered separator data-walk="list">
          <q-item
            v-for="kind in kinds"
            :key="kind.key"
            clickable
            :active="kind.key === selected"
            :data-test="`mail-kind-${kind.key}`"
            @click="select(kind.key)"
          >
            <q-item-section>
              <q-item-label>{{ kindLabel(kind.key) }}</q-item-label>
              <q-item-label caption>{{ t(`mail.types.${kind.type}`) }}</q-item-label>
            </q-item-section>
          </q-item>
        </q-list>
      </div>

      <div v-if="current" class="col-12 col-md-9 column q-gutter-md">
        <q-tabs v-model="locale" dense align="left" no-caps class="text-primary" @update:model-value="load">
          <q-tab v-for="each in LOCALES" :key="each" :name="each" :label="t(`app.locales.${each}`)" :data-test="`mail-locale-${each}`" />
        </q-tabs>

        <q-input v-model="subject" outlined :label="t('mail.subject')" data-test="mail-subject" />
        <q-input v-model="body" type="textarea" outlined autogrow :label="t('mail.body')" input-class="code" data-test="mail-body" />

        <q-banner v-if="refusals.length" rounded class="bg-negative text-white" data-test="mail-problems">
          <div class="text-weight-medium">{{ t('mail.refused') }}</div>
          <div v-for="refusal in refusals" :key="refusal">{{ refusal }}</div>
        </q-banner>

        <div class="row q-gutter-sm">
          <q-btn outline color="primary" no-caps icon="visibility" :label="t('mail.preview')" :loading="previewing" data-test="mail-preview" @click="preview" />
          <q-btn color="primary" no-caps icon="save" :label="t('mail.save')" :loading="saving" :disable="!changed" data-test="mail-save" @click="save" />
        </div>

        <q-expansion-item dense icon="data_object" :label="t('mail.variables')">
          <div class="q-pa-sm">
            <p class="text-caption q-mb-sm">{{ t('mail.variablesHint', { example: LINK_EXAMPLE }) }}</p>
            <q-chip v-for="path in paths" :key="path" dense square class="code">{{ path }}</q-chip>
          </div>
        </q-expansion-item>

        <q-card v-if="rendered" flat bordered>
          <q-card-section>
            <MailPreview :mail="rendered" />
          </q-card-section>
        </q-card>

        <div>
          <h2 class="text-h6">{{ t('mail.history') }}</h2>
          <q-list bordered separator data-test="mail-history">
            <q-item v-for="revision in revisions" :key="revision.id">
              <q-item-section>
                <q-item-label>{{ revision.subject }}</q-item-label>
                <q-item-label caption>{{ dateTime(revision.createdAt) }} · {{ author(revision.authorId) }}</q-item-label>
              </q-item-section>
              <q-item-section side>
                <div class="row items-center q-gutter-xs">
                  <q-badge v-if="revision.id === current.revisionId" color="positive" :label="t('mail.active')" />
                  <q-btn flat dense no-caps :label="t('mail.compare')" @click="compare(revision)" />
                  <q-btn flat dense no-caps :label="t('mail.load')" @click="loadRevision(revision)" />
                  <q-btn
                    v-if="revision.id !== current.revisionId"
                    flat
                    dense
                    no-caps
                    color="primary"
                    :label="t('mail.activate')"
                    data-test="mail-activate"
                    @click="activate(revision)"
                  />
                </div>
              </q-item-section>
            </q-item>
          </q-list>
        </div>
      </div>
    </div>

    <q-dialog v-model="comparing">
      <q-card class="compare">
        <q-card-section>
          <h2 class="text-h6 q-my-none">{{ t('mail.compareTitle', { date: dateTime(compared?.createdAt) }) }}</h2>
        </q-card-section>
        <q-card-section>
          <pre class="code diff"><span v-for="(line, index) in difference" :key="index" :class="line.kind">{{ marks[line.kind] }} {{ line.text }}
</span></pre>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn v-close-popup flat no-caps :label="t('mail.close')" />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-page>
</template>

<script setup lang="ts">
import { LOCALES, type Locale, type MailKindInfo, type MailPreview as RenderedMail, type MailTemplate, type MailTemplateRevision } from '@app/api/client'
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import MailPreview from '@/components/MailPreview.vue'
import { client } from '@/api/feathers'
import { diffLines, type DiffLine } from '@/composables/diff'
import { useFormat } from '@/composables/format'
import { useMail, variablePaths } from '@/composables/mail'
import { useNotify } from '@/composables/notify'

// Mail wording (ADR 0027), the admin's alone (ADR 0011): per kind and
// locale a subject and a Markdown body with Liquid. Saving checks the
// wording against what the kind supplies and keeps every version; an
// older one can be compared and activated again.

const { t } = useI18n()
const { dateTime } = useFormat()
// Liquid, so not an i18n message: vue-i18n would read its braces.
const LINK_EXAMPLE = '[…]({{ app.url }}/profile)'
const { kindLabel, problems } = useMail()
const notify = useNotify()

const kinds = ref<MailKindInfo[]>([])
const templates = ref<MailTemplate[]>([])
const selected = ref<string | null>(null)
const locale = ref<Locale>('de')
const subject = ref('')
const body = ref('')
const revisions = ref<MailTemplateRevision[]>([])
const rendered = ref<RenderedMail | null>(null)
const refusals = ref<string[]>([])
const previewing = ref(false)
const saving = ref(false)

const current = computed(() => templates.value.find((each) => each.kind === selected.value && each.locale === locale.value))
const changed = computed(() => !!current.value && (subject.value !== current.value.subject || body.value !== current.value.body))
const paths = computed(() => {
  const kind = kinds.value.find((each) => each.key === selected.value)
  return kind ? variablePaths(kind.variables) : []
})

// Authors are admins, named where the account still exists.
const names = reactive(new Map<string, string>())
const author = (id: string | null) => (id ? (names.get(id) ?? '…') : t('mail.system'))
const resolveAuthors = async () => {
  for (const id of new Set(revisions.value.map((revision) => revision.authorId).filter((id): id is string => !!id && !names.has(id)))) {
    names.set(id, id.slice(0, 8))
    const user = await client.service('users').get(id).catch(() => null)
    if (user) names.set(id, [user.givenName, user.surname].filter(Boolean).join(' ') || (user.tuId ?? id))
  }
}

const loadHistory = async () => {
  if (!selected.value) return
  const page = await client
    .service('mail-template-revisions')
    .find({ query: { kind: selected.value, locale: locale.value, $limit: 50 } })
  revisions.value = page.data
  await resolveAuthors()
}

const load = async () => {
  rendered.value = null
  refusals.value = []
  subject.value = current.value?.subject ?? ''
  body.value = current.value?.body ?? ''
  await loadHistory().catch(notify.failure)
}

const select = async (key: string) => {
  selected.value = key
  await load()
}

const refresh = async () => {
  templates.value = await client.service('mail-templates').find()
}

onMounted(async () => {
  try {
    ;[kinds.value] = await Promise.all([client.service('mail-kinds').find(), refresh()])
    if (kinds.value[0]) await select(kinds.value[0].key)
  } catch (error) {
    notify.failure(error)
  }
})

const refused = (error: unknown) => {
  refusals.value = problems(error)
  if (!refusals.value.length) notify.failure(error)
}

const preview = async () => {
  if (!selected.value) return
  previewing.value = true
  refusals.value = []
  try {
    rendered.value = await client
      .service('mail-previews')
      .create({ kind: selected.value, locale: locale.value, subject: subject.value, body: body.value })
  } catch (error) {
    rendered.value = null
    refused(error)
  } finally {
    previewing.value = false
  }
}

const save = async () => {
  if (!selected.value) return
  saving.value = true
  refusals.value = []
  try {
    await client
      .service('mail-template-revisions')
      .create({ kind: selected.value, locale: locale.value, subject: subject.value, body: body.value })
    await refresh()
    await loadHistory()
    notify.success(t('mail.saved'))
  } catch (error) {
    refused(error)
  } finally {
    saving.value = false
  }
}

const activate = async (revision: MailTemplateRevision) => {
  try {
    await client.service('mail-templates').patch(`${revision.kind}:${revision.locale}`, { revisionId: revision.id })
    await refresh()
    await load()
    notify.success(t('mail.activated'))
  } catch (error) {
    notify.failure(error)
  }
}

const loadRevision = (revision: MailTemplateRevision) => {
  subject.value = revision.subject
  body.value = revision.body
}

const comparing = ref(false)
const compared = ref<MailTemplateRevision | null>(null)
const marks: Record<DiffLine['kind'], string> = { same: ' ', removed: '−', added: '+' }
const difference = computed(() =>
  compared.value
    ? diffLines(`${compared.value.subject}\n\n${compared.value.body}`, `${subject.value}\n\n${body.value}`)
    : []
)
const compare = (revision: MailTemplateRevision) => {
  compared.value = revision
  comparing.value = true
}
</script>

<style scoped>
.code,
:deep(.code) {
  font-family: ui-monospace, monospace;
}
.compare {
  width: 100%;
  max-width: 900px;
}
.diff {
  white-space: pre-wrap;
  margin: 0;
}
.diff .removed {
  background: rgba(193, 0, 21, 0.12);
}
.diff .added {
  background: rgba(33, 186, 69, 0.15);
}
</style>
