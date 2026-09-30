import type { RouteRecordRaw } from 'vue-router'

declare module 'vue-router' {
  interface RouteMeta {
    // Reachable without a session.
    public?: boolean
    // Hidden unless the user may do this to every record of the subject
    // (ADR 0011). The server enforces; this only avoids dead ends.
    requires?: [action: string, subject: string]
    // Hidden unless the user may do this to some record of it, e.g. their
    // own documents.
    requiresSome?: [action: string, subject: string]
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
      // Under documents.own or documents.all (ADR 0011), and read-only in a
      // view-as (ADR 0028).
      {
        path: 'documents',
        name: 'documents',
        component: () => import('@/pages/DocumentsPage.vue'),
        meta: { requiresSome: ['read', 'documents'] }
      },
      {
        path: 'users',
        name: 'users',
        component: () => import('@/pages/UsersPage.vue'),
        meta: { requires: ['read', 'users'] }
      },
      // Roles and what they grant: the admin's alone (ADR 0011).
      {
        path: 'permissions',
        name: 'permissions',
        component: () => import('@/pages/PermissionsPage.vue'),
        meta: { requires: ['create', 'roles'] }
      },
      {
        path: 'settings',
        name: 'settings',
        component: () => import('@/pages/SettingsPage.vue'),
        meta: { requires: ['read', 'settings'] }
      },
      // Every session, under sessions.read (ADR 0011).
      {
        path: 'sessions',
        name: 'sessions',
        component: () => import('@/pages/SessionsPage.vue'),
        meta: { requires: ['read', 'sessions'] }
      },
      {
        path: 'audit',
        name: 'audit',
        component: () => import('@/pages/AuditPage.vue'),
        meta: { requires: ['read', 'audit-events'] }
      },
      // Data subject requests (ADR 0013), under erasures.create.
      {
        path: 'gdpr',
        name: 'gdpr',
        component: () => import('@/pages/GdprPage.vue'),
        meta: { requires: ['create', 'erasures'] }
      },
      // Mail (ADR 0027), under mail.manage.
      {
        path: 'mail/templates',
        name: 'mail-templates',
        component: () => import('@/pages/MailTemplatesPage.vue'),
        meta: { requires: ['read', 'mail-templates'] }
      },
      {
        path: 'mail/campaigns',
        name: 'mailings',
        component: () => import('@/pages/MailingsPage.vue'),
        meta: { requires: ['create', 'mail-campaigns'] }
      },
      // The job queues (ADR 0024), under queues.read.
      {
        path: 'queues',
        name: 'queues',
        component: () => import('@/pages/QueuesPage.vue'),
        meta: { requires: ['read', 'queues'] }
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
