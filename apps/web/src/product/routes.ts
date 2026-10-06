import type { RouteRecordRaw } from 'vue-router'
import type { NavLink } from '@/router/nav'

// The product's pages (ADR 0014, 0035), rendered in the main layout after
// the skeleton's, with the same `meta` (router/routes.ts). Route names are
// unique across both, and stable once released: a person's navigation order
// stores them.
export const PRODUCT_ROUTES: RouteRecordRaw[] = []

// The product's links in the navigation drawer, after the profile and
// before the skeleton's other links; each person may rearrange them. Labels
// go into i18n/product/.
export const PRODUCT_NAV_LINKS: NavLink[] = []
