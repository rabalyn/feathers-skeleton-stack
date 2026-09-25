import { defineRouter } from '#q-app'
import { watch } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import { useSessionStore } from '@/stores/session'
import routes from './routes'

// History mode; Nginx serves index.html for every unmatched path (ADR 0014,
// 0016).
export default defineRouter(({ store }) => {
  const router = createRouter({
    scrollBehavior: () => ({ left: 0, top: 0 }),
    routes,
    history: createWebHistory(import.meta.env.QUASAR_VUE_ROUTER_BASE)
  })
  const session = useSessionStore(store)

  router.beforeEach(async (to) => {
    // Nothing authenticated renders before the session is known.
    await session.settled
    if (to.name === 'login') {
      return session.isAuthenticated ? safePath(to.query.returnTo) : true
    }
    if (to.meta.public) return true
    if (!session.isAuthenticated) {
      return { name: 'login', query: to.fullPath === '/' ? {} : { returnTo: to.fullPath } }
    }
    if (to.meta.requires && !session.canAll(...to.meta.requires)) return { name: 'profile' }
    return true
  })

  // A session that ends while a page is open (expiry, revocation, a logout
  // in another tab) leads back to the login page.
  watch(
    () => session.status,
    (status) => {
      const current = router.currentRoute.value
      if (status === 'anonymous' && !current.meta.public) {
        void router.replace({ name: 'login', query: { returnTo: current.fullPath } })
      }
    }
  )

  return router
})

// Only same-origin paths, as the API does for its own returnTo (ADR 0008).
const safePath = (value: unknown): string =>
  typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/'
