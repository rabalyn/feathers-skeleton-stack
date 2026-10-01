import type { Preference, PreferenceValues } from '@app/api/client'
import { ref, watch } from 'vue'
import { client } from '@/api/feathers'
import { useNotify } from '@/composables/notify'
import { useSessionStore } from '@/stores/session'

// The person's own order of the navigation drawer, kept as the `navOrder`
// preference so it follows them to every browser (decided 2026-10-02,
// ADR 0014).

type NavOrder = PreferenceValues['navOrder']

export const useNavOrder = () => {
  const session = useSessionStore()
  const notify = useNotify()
  const service = client.service('preferences')
  const record = ref<Preference | null>(null)

  const load = async () => {
    try {
      const page = await service.find({ query: { key: 'navOrder', $limit: 1 } })
      record.value = page.data[0] ?? null
    } catch {
      // Without the permission, or while viewing as somebody: the default.
      record.value = null
    }
  }

  // Whenever somebody else is signed in, or viewed as.
  watch(
    () => (session.status === 'authenticated' ? session.user?.id : undefined),
    (id) => {
      record.value = null
      if (id) void load()
    },
    { immediate: true }
  )

  // The person's other tabs and browsers (ADR 0012).
  const own = (next: Preference) => next.key === 'navOrder' && next.userId === session.user?.id
  service.on('created', (next: Preference) => {
    if (own(next)) record.value = next
  })
  service.on('removed', (gone: Preference) => {
    if (own(gone)) record.value = null
  })

  const order = () => (record.value?.value as NavOrder | undefined) ?? null

  const save = async (names: NavOrder) => {
    const previous = record.value
    // At once on screen; put back if the write fails.
    record.value = { ...(previous ?? ({} as Preference)), key: 'navOrder', value: names }
    try {
      record.value = await service.create({ key: 'navOrder', value: names })
    } catch (error) {
      record.value = previous
      notify.failure(error)
    }
  }

  const reset = async () => {
    const previous = record.value
    if (!previous?.id) return
    record.value = null
    try {
      await service.remove(previous.id)
    } catch (error) {
      record.value = previous
      notify.failure(error)
    }
  }

  return { order, save, reset }
}
