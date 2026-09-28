<template>
  <q-page padding>
    <h1 class="text-h5 q-mt-none">{{ t('nav.documents') }}</h1>

    <q-form class="new-document row items-start q-gutter-sm q-mb-md" @submit="create">
      <q-input
        v-model="title"
        :label="t('documents.title')"
        :rules="[(value: string) => !!value.trim() || t('documents.title')]"
        maxlength="200"
        dense
        outlined
        class="col-grow"
        data-test="document-title"
      />
      <q-file
        v-model="picked"
        :accept="ALLOWED_CONTENT_TYPES.join(',')"
        :label="t('documents.file')"
        :hint="t('documents.hint')"
        dense
        outlined
        class="col-grow"
        data-test="document-file"
      />
      <q-btn type="submit" color="primary" no-caps :label="t('documents.create')" :loading="busy" :disable="!picked" />
    </q-form>

    <q-table
      :pagination="pagination"
      :rows="rows"
      :columns="columns"
      row-key="id"
      :loading="documents.isPending"
      :rows-per-page-options="[10, 25, 50, 100]"
      :no-data-label="t('documents.empty')"
      flat
      bordered
      @request="onRequest"
    >
      <template #body-cell-actions="props">
        <q-td :props="props" class="text-right">
          <q-btn
            flat
            round
            dense
            icon="download"
            :aria-label="t('documents.download')"
            @click="download(props.row)"
          />
          <q-btn
            flat
            round
            dense
            icon="delete"
            color="negative"
            :aria-label="t('documents.remove')"
            @click="confirmRemove(props.row)"
          />
        </q-td>
      </template>
    </q-table>
  </q-page>
</template>

<script setup lang="ts">
import { ALLOWED_CONTENT_TYPES, type Document, type User } from '@app/api/client'
import { useQuasar, type QTableProps } from 'quasar'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { downloadFile, uploadFile } from '@/api/files'
import { useApi } from '@/boot/feathers'
import { useFormat } from '@/composables/format'
import { useNotify } from '@/composables/notify'
import { useSessionStore } from '@/stores/session'

// Documents (ADR 0009, 0020): a user sees and manages their own; operators
// and admins see everyone's, with the owner shown (ADR 0011). The list
// follows changes live through the documents channel (ADR 0012).

const api = useApi()
const session = useSessionStore()
const $q = useQuasar()
const { t } = useI18n()
const { dateTime, bytes } = useFormat()
const notify = useNotify()

const seesEveryone = computed(() => session.canAll('read', 'documents'))

const paging = ref({ page: 1, rowsPerPage: 25, sortBy: 'updatedAt', descending: true })
const params = computed(() => ({
  query: {
    $sort: { [paging.value.sortBy]: paging.value.descending ? -1 : 1 },
    $limit: paging.value.rowsPerPage,
    $skip: (paging.value.page - 1) * paging.value.rowsPerPage
  }
}))
const documents = api.service('documents').useFind(params, { paginateOn: 'server' })
const rows = computed(() => documents.data as Document[])
const pagination = computed(() => ({ ...paging.value, rowsNumber: documents.total }))

const onRequest: QTableProps['onRequest'] = ({ pagination: next }) => {
  paging.value = {
    page: next.page ?? 1,
    rowsPerPage: next.rowsPerPage ?? 25,
    sortBy: next.sortBy ?? 'updatedAt',
    descending: next.descending ?? true
  }
}

// Owners by TU-ID, for those who see everyone's documents and may read
// users anyway.
const owners = ref(new Map<string, User>())
watch(
  () => (seesEveryone.value && session.canAll('read', 'users') ? rows.value.map((d) => d.ownerId) : []),
  async (ids) => {
    const missing = [...new Set(ids)].filter((id) => !owners.value.has(id))
    if (!missing.length) return
    const found = await api.service('users').find({ query: { id: { $in: missing }, $limit: missing.length } })
    for (const user of found.data as User[]) owners.value.set(user.id, user)
  },
  { immediate: true }
)

const columns = computed<NonNullable<QTableProps['columns']>>(() => [
  { name: 'title', field: 'title', label: t('documents.title'), align: 'left', sortable: true },
  { name: 'file', field: (row: Document) => row.file?.filename, label: t('documents.file'), align: 'left' },
  {
    name: 'size',
    field: (row: Document) => row.file?.sizeBytes,
    label: t('documents.size'),
    align: 'right',
    format: (value: number | undefined) => bytes(value)
  },
  ...(seesEveryone.value
    ? [
        {
          name: 'owner',
          field: (row: Document) => owners.value.get(row.ownerId)?.tuId ?? '',
          label: t('documents.owner'),
          align: 'left' as const
        }
      ]
    : []),
  {
    name: 'updatedAt',
    field: 'updatedAt',
    label: t('documents.updatedAt'),
    align: 'left',
    sortable: true,
    format: (value: string) => dateTime(value)
  },
  { name: 'actions', field: 'id', label: '', align: 'right' }
])

const title = ref('')
const picked = ref<File | null>(null)
const busy = ref(false)

// The file goes up first; the document then attaches it (ADR 0020).
const create = async () => {
  if (!picked.value) return
  busy.value = true
  try {
    const stored = await uploadFile(picked.value)
    await api.service('documents').create({ title: title.value.trim(), fileId: stored.id })
    notify.success(t('documents.created'))
    title.value = ''
    picked.value = null
  } catch (error) {
    notify.failure(error)
  } finally {
    busy.value = false
  }
}

const download = async (document: Document) => {
  try {
    await downloadFile(document.fileId, document.file?.filename ?? document.title)
  } catch (error) {
    notify.failure(error)
  }
}

const confirmRemove = (document: Document) => {
  $q.dialog({
    message: t('documents.confirmRemove', { title: document.title }),
    cancel: { label: t('documents.cancel'), flat: true, noCaps: true },
    ok: { label: t('documents.remove'), color: 'negative', noCaps: true }
  }).onOk(() => void remove(document))
}

const remove = async (document: Document) => {
  try {
    await api.service('documents').remove(document.id)
    notify.success(t('documents.removed'))
  } catch (error) {
    notify.failure(error)
  }
}
</script>

<style scoped>
.new-document {
  max-width: 960px;
}
</style>
