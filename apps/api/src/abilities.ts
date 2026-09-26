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

  // Own user record: read, for every role, and its avatar, set through
  // `avatars`, which only ever acts on the caller's own record. Directory
  // fields are writable by nobody (ADR 0009).
  can('read', 'users', { id: user.id })
  // `read` too, which feathers-casl checks on a create's result: the
  // caller's own user record.
  can(['create', 'read'], 'avatars')

  // Uploads (ADR 0020): everyone uploads; a file is readable where its
  // owner's records are. `file-contents` checks the `files` rule on the
  // record itself, so it is open here.
  can('create', 'files')
  can('read', 'files', { ownerId: user.id })
  can('read', 'file-contents')

  // Documents: the caller always becomes the owner of what they create.
  can('create', 'documents')

  switch (user.role) {
    case 'admin':
      can('read', 'users')
      // Role assignment and enable/disable. Which fields a patch may carry
      // is fixed by the users patch schema.
      can('patch', 'users')
      // All avatars, all documents (ADR 0011).
      can('read', 'files')
      can(['read', 'write', 'delete'], 'documents')
      // Runtime settings (ADR 0025): configuration is the admin's alone.
      can('read', 'settings')
      can('patch', 'settings')
      // Directory lookup (ADR 0008).
      can('read', 'directory')
      break
    case 'operator':
      can('read', 'users')
      can('read', 'directory')
      can('read', 'files')
      can(['read', 'write', 'delete'], 'documents')
      break
    case 'user':
      // Their own documents only; lists are scoped by the same condition.
      can(['read', 'write', 'delete'], 'documents', { ownerId: user.id })
      break
  }

  return build({ resolveAction })
}
