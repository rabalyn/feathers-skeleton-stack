import { defineBoot } from '#q-app'
import { createApi, type Api } from '@/api/feathers'
import { useSessionStore } from '@/stores/session'

declare module 'vue' {
  interface ComponentCustomProperties {
    $api: Api
  }
}

let api: Api | undefined
export const useApi = (): Api => {
  if (!api) throw new Error('The API client is created by the feathers boot file')
  return api
}

export default defineBoot(({ app, store }) => {
  api = createApi(store)
  app.config.globalProperties.$api = api
  // Not awaited: the page mounts at once and shows the start state; the
  // router waits for the answer (ADR 0014).
  useSessionStore(store).start()
})
