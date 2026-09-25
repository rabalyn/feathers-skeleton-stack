import { AbilityBuilder, createAliasResolver, createMongoAbility, type MongoAbility } from '@casl/ability'

// Role abilities (ADR 0011): the one module where authorization rules live.
// It is imported by the browser through the client entry point to hide
// actions, so it must import nothing but @casl/ability (ADR 0007). The
// server remains the only enforcement point.

export const ROLES = ['admin', 'operator', 'user'] as const
export type Role = (typeof ROLES)[number]

export interface AbilityUser {
  id: string
  role: Role
}

// Feathers methods, grouped into the actions the permission matrix uses.
const resolveAction = createAliasResolver({
  read: ['get', 'find'],
  write: ['create', 'update', 'patch'],
  delete: ['remove']
})

export type AppAbility = MongoAbility

export const defineAbilitiesFor = (user: AbilityUser): AppAbility => {
  const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility)

  // Own user record: read, for every role. Writing the avatar arrives with
  // uploads; directory fields are writable by nobody (ADR 0009).
  can('read', 'users', { id: user.id })

  switch (user.role) {
    case 'admin':
      can('read', 'users')
      // Role assignment and enable/disable. Which fields a patch may carry
      // is fixed by the users patch schema.
      can('patch', 'users')
      // Runtime settings (ADR 0025): operator observes, admin changes.
      can('read', 'settings')
      can('patch', 'settings')
      break
    case 'operator':
      can('read', 'users')
      can('read', 'settings')
      break
    case 'user':
      break
  }

  return build({ resolveAction })
}
