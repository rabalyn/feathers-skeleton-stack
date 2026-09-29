import type { Locale, Role } from '@app/api/client'
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useApi } from '@/boot/feathers'
import { useSessionStore } from '@/stores/session'

// Roles as far as the caller may read them (ADR 0011): every role for those
// who see all users, the names of their own for everybody else. Kept
// current by the roles service's events, and read again when the caller's
// rights change, which may reveal roles the events never brought.
export const useRoles = () => {
  const api = useApi()
  const { locale, t } = useI18n()
  const found = api.service('roles').useFind(computed(() => ({ query: { $sort: { key: 1 }, $limit: 100 } })), {
    paginateOn: 'server'
  })
  const session = useSessionStore()
  watch(
    () => session.ability,
    () => void found.find()
  )
  const roles = computed(() => found.data as Role[])
  const name = (role: Pick<Role, 'key' | 'name'>) => role.name[locale.value as Locale] ?? role.key
  const nameOf = (id: string) => {
    const role = roles.value.find((candidate) => candidate.id === id)
    return role ? name(role) : ''
  }
  // A person's roles as text; one the caller may not read is left out.
  const namesOf = (ids: readonly string[]) => (ids.length ? ids.map(nameOf).filter(Boolean).join(', ') : t('user.noRoles'))
  return { roles, found, name, nameOf, namesOf }
}

// A permission's label and description (ADR 0011). Keys replace the dots of
// the permission key, which vue-i18n would read as nesting.
export const usePermissionLabels = () => {
  const { t } = useI18n()
  const slug = (key: string) => key.replace(/\./g, '_')
  return {
    label: (key: string) => t(`permissions.keys.${slug(key)}`),
    description: (key: string) => t(`permissions.descriptions.${slug(key)}`),
    group: (group: string) => t(`permissions.groups.${group}`)
  }
}
