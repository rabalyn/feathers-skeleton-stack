import type { RouteRecordRaw } from 'vue-router'

declare module 'vue-router' {
  interface RouteMeta {
    // Reachable without a session.
    public?: boolean
    // Hidden unless the user may do this to every record of the subject
    // (ADR 0011). The server enforces; this only avoids dead ends.
    requires?: [action: string, subject: string]
  }
}

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/pages/LoginPage.vue'),
    meta: { public: true }
  },
  // The break-glass login (ADR 0008): nothing links here.
  {
    path: '/break-glass',
    name: 'break-glass',
    component: () => import('@/pages/BreakGlassPage.vue'),
    meta: { public: true }
  },
  {
    path: '/',
    component: () => import('@/layouts/MainLayout.vue'),
    children: [
      { path: '', redirect: { name: 'profile' } },
      { path: 'profile', name: 'profile', component: () => import('@/pages/ProfilePage.vue') },
      {
        path: 'users',
        name: 'users',
        component: () => import('@/pages/UsersPage.vue'),
        meta: { requires: ['read', 'users'] }
      },
      {
        path: 'settings',
        name: 'settings',
        component: () => import('@/pages/SettingsPage.vue'),
        meta: { requires: ['read', 'settings'] }
      },
      {
        path: 'directory',
        name: 'directory',
        component: () => import('@/pages/DirectoryPage.vue'),
        meta: { requires: ['read', 'directory'] }
      }
    ]
  },
  {
    path: '/:catchAll(.*)*',
    name: 'not-found',
    component: () => import('@/pages/ErrorNotFound.vue'),
    meta: { public: true }
  }
]

export default routes
