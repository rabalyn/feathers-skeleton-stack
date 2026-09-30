import { defineRouter } from '#q-app'
import { watch } from 'vue'
import { createRouter, createWebHistory, type RouteMeta } from 'vue-router'
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
  const allowed = (meta: RouteMeta) =>
    (!meta.requires || session.canAll(...meta.requires)) &&
    (!meta.requiresSome || session.can(...meta.requiresSome)) &&
    (!meta.requiresAny || meta.requiresAny.some((pair) => session.canAll(...pair)))

  router.beforeEach(async (to) => {
    // Nothing authenticated renders before the session is known.
    await session.settled
    if (to.name === 'login' || to.name === 'break-glass') {
      return session.isAuthenticated ? safePath(to.query.returnTo) : true
    }
    if (to.meta.public) return true
    if (!session.isAuthenticated) {
      return { name: 'login', query: to.fullPath === '/' ? {} : { returnTo: to.fullPath } }
    }
    if (!allowed(to.meta)) return { name: 'profile' }
    return true
  })

  // A session that ends while a page is open (expiry, revocation, a logout
  // in another tab) leads back to the login page. Before the first
  // navigation has finished no page is open: the guard above decides, so a
  // first visit to another public page is not sent to the login page.
  watch(
    () => session.status,
    (status) => {
      const current = router.currentRoute.value
      if (status === 'anonymous' && current.matched.length > 0 && !current.meta.public) {
        void router.replace({ name: 'login', query: { returnTo: current.fullPath } })
      }
    }
  )

  // Rights that change while a page is open (a new role after a forced
  // re-authentication, ADR 0012) leave a page they no longer allow.
  watch(
    () => session.ability,
    () => {
      const current = router.currentRoute.value
      if (session.isAuthenticated && !allowed(current.meta)) {
        void router.replace({ name: 'profile' })
      }
    }
  )

  return router
})

// Only same-origin paths, as the API does for its own returnTo (ADR 0008).
const safePath = (value: unknown): string =>
  typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/'
