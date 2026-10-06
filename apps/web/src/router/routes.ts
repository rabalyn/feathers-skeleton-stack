import type { RouteRecordRaw } from 'vue-router'
import { PRODUCT_ROUTES } from '@/product/routes'

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
    // Hidden unless the user may do one of these to every record of its
    // subject.
    requiresAny?: [action: string, subject: string][]
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
  // Maintenance mode (ADR 0025): where the ACS sends a refused login, and
  // where the browser waits while the API is down.
  {
    path: '/maintenance',
    name: 'maintenance',
    component: () => import('@/pages/MaintenancePage.vue'),
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
      // API tokens (ADR 0029): for whoever may create them or see everybody's.
      {
        path: 'api-tokens',
        name: 'api-tokens',
        component: () => import('@/pages/ApiTokensPage.vue'),
        meta: {
          requiresAny: [
            ['create', 'api-tokens'],
            ['read', 'api-tokens']
          ]
        }
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
      // What runs and which updates are out (ADR 0032), under system-info.read.
      {
        path: 'system-info',
        name: 'system-info',
        component: () => import('@/pages/SystemInfoPage.vue'),
        meta: { requires: ['read', 'system-info'] }
      },
      // The ADRs and diagrams (ADR 0019), under docs.read.
      {
        path: 'docs',
        name: 'docs',
        component: () => import('@/pages/DocsPage.vue'),
        meta: { requires: ['read', 'docs'] }
      },
      // The address lookup (ADR 0031): every signed-in person.
      {
        path: 'sites',
        name: 'sites',
        component: () => import('@/pages/SitesPage.vue'),
        meta: { requires: ['read', 'sites'] }
      },
      {
        path: 'directory',
        name: 'directory',
        component: () => import('@/pages/DirectoryPage.vue'),
        meta: { requires: ['read', 'directory'] }
      },
      // The product's (ADR 0035).
      ...PRODUCT_ROUTES
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
