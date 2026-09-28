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
// No service offers `update` (ADR 0006), so `write` does not cover it.
const resolveAction = createAliasResolver({
  read: ['get', 'find'],
  write: ['create', 'patch'],
  delete: ['remove']
})

export type AppAbility = MongoAbility

// What an operator reads of someone else's session: everything but the
// user agent (decided 2026-09-28, ADR 0011).
const OPERATOR_SESSION_FIELDS = ['id', 'userId', 'issuedAt', 'lastUsedAt', 'idleExpiresAt', 'familyExpiresAt', 'revokedAt']

export const defineAbilitiesFor = (user: AbilityUser): AppAbility => {
  const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility)

  // Own user record: read, for every role, and its avatar, set through
  // `avatars`, which only ever acts on the caller's own record. Directory
  // fields are writable by nobody (ADR 0009).
  can('read', 'users', { id: user.id })
  // `read` too, which feathers-casl checks on a create's result: the
  // caller's own user record.
  can(['create', 'read'], 'avatars')
  // The language mail reaches the caller in (ADR 0027), likewise their own.
  can(['create', 'read'], 'locales')

  // Uploads (ADR 0020): everyone uploads; a file is readable where its
  // owner's records are. `file-contents` checks the `files` rule on the
  // record itself, so it is open here.
  can('create', 'files')
  can('read', 'files', { ownerId: user.id })
  can('read', 'file-contents')

  // Documents: the caller always becomes the owner of what they create.
  can('create', 'documents')

  // GDPR export (ADR 0013): every role exports itself, an admin anyone.
  // An export is seen and fetched by the account that asked for it only.
  can('create', 'data-exports', { subjectId: user.id })
  can('read', 'data-exports', { requestedBy: user.id })
  // Checks the `data-exports` rule on the record itself, like file-contents.
  can('read', 'data-export-contents')

  // Audit events (ADR 0011, 0013): what the caller did; all of them for
  // admins and operators below.
  can('read', 'audit-events', { actorId: user.id })

  // Sessions (ADR 0010, 0011): everyone sees and revokes their own logins.
  can(['read', 'delete'], 'sessions', { userId: user.id })

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
      can('read', 'audit-events')
      can('create', 'data-exports')
      // Erasure (ADR 0013): the admin's alone; `read` for feathers-casl's
      // check of the create's result.
      can(['create', 'read'], 'erasures')
      // Mail (ADR 0027): the wording of the application's mail is runtime
      // behaviour, the admin's alone. `read` on previews for feathers-casl's
      // check of the create's result.
      can('read', 'mail-kinds')
      can(['read', 'patch'], 'mail-templates')
      can(['read', 'create'], 'mail-template-revisions')
      can(['create', 'read'], 'mail-previews')
      can(['read', 'create'], 'mail-campaigns')
      can(['create', 'read'], 'mail-campaign-previews')
      can('read', 'mail-deliveries')
      // The queue view (ADR 0024): runtime state, read-only.
      can('read', 'queues')
      can(['read', 'delete'], 'sessions')
      break
    case 'operator':
      can('read', 'users')
      can('read', 'directory')
      can('read', 'audit-events')
      can('read', 'files')
      can(['read', 'write', 'delete'], 'documents')
      // Every session, but not the browser it was opened in.
      can('read', 'sessions', OPERATOR_SESSION_FIELDS)
      break
    case 'user':
      // Their own documents only; lists are scoped by the same condition.
      can(['read', 'write', 'delete'], 'documents', { ownerId: user.id })
      break
  }

  return build({ resolveAction })
}
