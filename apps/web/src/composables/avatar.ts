import { onScopeDispose, ref, watch, type Ref } from 'vue'
import { fetchFile } from '@/api/files'

// An avatar as an <img> can show it: fetched with the access token and
// handed over as a blob URL, which is released when the avatar changes or
// the component goes (ADR 0020).
export const useAvatarUrl = (fileId: Ref<string | null | undefined>) => {
  const url = ref<string | null>(null)
  const release = () => {
    if (url.value) URL.revokeObjectURL(url.value)
    url.value = null
  }
  watch(
    fileId,
    async (id) => {
      release()
      if (!id) return
      try {
        const blob = await fetchFile(id)
        // A newer avatar may have arrived meanwhile.
        if (fileId.value === id) url.value = URL.createObjectURL(blob)
      } catch {
        // No picture is shown; the placeholder stays.
      }
    },
    { immediate: true }
  )
  onScopeDispose(release)
  return url
}
