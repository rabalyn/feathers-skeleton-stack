import { AbilityBuilder, createAliasResolver, createMongoAbility, type RawRuleOf } from '@casl/ability'
import { entry, type AbilityUser, type AppAbility, type Can, type PermissionEntry } from './permission-entry.js'
import { PRODUCT_PERMISSIONS, PRODUCT_TOKEN_EXCLUDED_PERMISSIONS } from './product/permissions.js'

// Authorization (ADR 0011): the one module where rules live. Permissions are
// declared here, in the catalogue; roles, which an admin composes from them,
// are rows in the database. It is imported by the browser through the client
// entry point to hide actions, so it must import nothing but @casl/ability
// (ADR 0007). The server remains the only enforcement point. A product's
// own permissions are in product/permissions.ts (ADR 0035).

export type { AbilityUser, AppAbility, PermissionEntry } from './permission-entry.js'

// Feathers methods, grouped into the actions the permission catalogue uses.
// No service offers `update` (ADR 0006), so `write` does not cover it.
const resolveAction = createAliasResolver({
  read: ['get', 'find'],
  write: ['create', 'patch'],
  delete: ['remove']
})

// What `sessions.read` shows of a session: everything but the user agent,
// which `sessions.read-user-agent` adds (decided 2026-09-28, ADR 0011).
const SESSION_FIELDS_WITHOUT_USER_AGENT = ['id', 'userId', 'issuedAt', 'lastUsedAt', 'idleExpiresAt', 'familyExpiresAt', 'revokedAt']

// What anybody who sees user records reads of a role: its name, not what it
// grants.
const ROLE_NAME_FIELDS = ['id', 'key', 'kind', 'name']

// The permission catalogue (ADR 0011): the skeleton's entries here, the
// product's in product/permissions.ts. The web app translates
// `permissions.keys.<key>` and `permissions.descriptions.<key>`. A key is
// stable once released: roles store it.
const CATALOGUE_ENTRIES = [
  // One's own data beyond the fixed core (ADR 0011). The `everyone` role,
  // which every signed-in account holds, is seeded with all of them; an
  // admin may withdraw them there, or grant them through other roles only.
  entry('profile.avatar', 'self', (can) => can('create', 'avatars')),
  // The language mail reaches the caller in (ADR 0027).
  entry('profile.locale', 'self', (can) => can('create', 'locales')),
  // Personal preferences, such as the order of the navigation (decided
  // 2026-10-02, ADR 0014). A create sets the caller's own row.
  entry('profile.preferences', 'self', (can, user) => {
    can('create', 'preferences')
    can(['read', 'delete'], 'preferences', { userId: user.id })
  }),
  // Uploads (ADR 0020). The caller owns what they upload, and reads only
  // that: the create would otherwise imply reading every file (ADR 0036).
  entry('files.upload', 'self', (can, user) => {
    can('create', 'files')
    can('read', 'files', { ownerId: user.id })
  }),
  entry('files.own', 'self', (can, user) => can('read', 'files', { ownerId: user.id })),
  // What the caller did (ADR 0011, 0013); their export holds it regardless.
  entry('audit-events.own', 'self', (can, user) => can('read', 'audit-events', { actorId: user.id })),
  // The names of the caller's own roles, shown on their profile.
  entry('roles.own-names', 'self', (can, user) => {
    if (user.roleIds?.length) can('read', 'roles', ROLE_NAME_FIELDS, { id: { $in: [...user.roleIds] } })
  }),
  // Seeing and revoking one's own API tokens, even after losing the right
  // to create them (ADR 0029).
  entry('api-tokens.own', 'self', (can, user) => can(['read', 'delete'], 'api-tokens', { userId: user.id })),
  entry('users.read', 'users', (can) => {
    // Their avatars come with them: file-contents follows the reference
    // (ADR 0020), so no rule over files is needed.
    can('read', 'users')
    can('read', 'roles', ROLE_NAME_FIELDS)
  }),
  // Which fields a patch may carry is fixed by the users patch schema.
  entry('users.enable', 'users', (can) => can('patch', 'users')),
  entry('directory.read', 'users', (can) => {
    can('read', 'directory')
    can('create', 'directory-lookups')
  }),
  // Locations (ADR 0031): the university's buildings, from NetBox.
  entry('sites.read', 'locations', (can) => can('read', 'sites')),
  // Their rooms, and adding one NetBox does not have.
  entry('locations.read', 'locations', (can) => can('read', 'locations')),
  entry('locations.create', 'locations', (can) => can('create', 'locations')),
  // Read-only view as another person, bounded by one's own rights (ADR 0028).
  entry('users.view-as', 'users', (can) => can('create', 'view-as')),
  // The caller always becomes the owner of what they create; lists are
  // scoped by the same condition.
  entry('documents.own', 'documents', (can, user) => {
    can('create', 'documents')
    can(['read', 'write', 'delete'], 'documents', { ownerId: user.id })
  }),
  entry('documents.all', 'documents', (can) => {
    // Their files come with them, through the document (ADR 0020).
    can(['read', 'write', 'delete'], 'documents')
  }),
  entry('sessions.read', 'sessions', (can) => can('read', 'sessions', SESSION_FIELDS_WITHOUT_USER_AGENT)),
  entry('sessions.read-user-agent', 'sessions', (can) => can('read', 'sessions')),
  // Its own read, without the user agent, in place of the one `delete`
  // would imply (ADR 0036).
  entry('sessions.revoke', 'sessions', (can) => {
    can('delete', 'sessions')
    can('read', 'sessions', SESSION_FIELDS_WITHOUT_USER_AGENT)
  }),
  entry('audit-events.read', 'privacy', (can) => can('read', 'audit-events')),
  // Reading the exports one asked for only: the create would otherwise imply
  // reading everyone's (ADR 0036).
  entry('data-exports.any', 'privacy', (can, user) => {
    can('create', 'data-exports')
    can('read', 'data-exports', { requestedBy: user.id })
  }),
  entry('erasures.create', 'privacy', (can) => can('create', 'erasures')),
  entry('settings.manage', 'configuration', (can) => can(['read', 'patch'], 'settings')),
  entry('mail.manage', 'configuration', (can) => {
    can('read', 'mail-kinds')
    can(['read', 'patch'], 'mail-templates')
    can(['read', 'create'], 'mail-template-revisions')
    can('create', 'mail-previews')
    can(['read', 'create'], 'mail-campaigns')
    can('create', 'mail-campaign-previews')
    can('read', 'mail-deliveries')
  }),
  entry('queues.read', 'configuration', (can) => can('read', 'queues')),
  // What runs and which updates are out (ADR 0032).
  entry('system-info.read', 'configuration', (can) => can('read', 'system-info')),
  // Running the update check now, an outbound request (ADR 0032).
  entry('system-info.check', 'configuration', (can) => can('create', 'update-checks')),
  // The ADRs and diagrams in the app (ADR 0019). Admin-only: no seeded role
  // holds it, since they describe the stack's topology.
  entry('docs.read', 'configuration', (can) => can('read', 'docs')),
  // API tokens (ADR 0029): creating one's own, bounded by one's own rights
  // on every request; seeing and revoking one's own is `api-tokens.own`.
  // Reading one's own only, as `api-tokens.own` does: the create would
  // otherwise imply reading everyone's (ADR 0036).
  entry('api-tokens.create', 'api', (can, user) => {
    can('create', 'api-tokens')
    can('read', 'api-tokens', { userId: user.id })
  }),
  entry('api-tokens.manage', 'api', (can) => can(['read', 'delete'], 'api-tokens')),
  // gen:service permissions (ADR 0030)
  ...PRODUCT_PERMISSIONS
]

export type PermissionKey = (typeof CATALOGUE_ENTRIES)[number]['key']
export const PERMISSIONS: readonly (PermissionEntry & { key: PermissionKey })[] = CATALOGUE_ENTRIES
export const PERMISSION_KEYS: readonly PermissionKey[] = PERMISSIONS.map((each) => each.key)
const CATALOGUE = new Map<string, PermissionEntry>(PERMISSIONS.map((each) => [each.key, each]))
if (CATALOGUE.size !== PERMISSIONS.length) throw new Error('permission catalogue: duplicate key')

export const isPermissionKey = (key: string): key is PermissionKey => CATALOGUE.has(key)

// Role management: `admin`'s alone and outside the catalogue, so no role can
// be granted it (ADR 0011). Only the fixed `admin` role yields this key.
export const ROLE_MANAGEMENT = 'roles.manage'

// The kinds of role (ADR 0011).
export const ROLE_KINDS = ['admin', 'everyone', 'seeded', 'custom'] as const
export type RoleKind = (typeof ROLE_KINDS)[number]

// What every signed-in account may do, whatever its roles: the fixed core,
// which the right of access requires and no role can withdraw (ADR 0011,
// 0013, decided 2026-10-01). The own user record, which also carries the
// caller's permissions; the own GDPR export, the full copy of their data
// (Art. 15, 20 GDPR); and ending one's own view-as. Everything else that
// was once given to everyone is a catalogue permission of the `everyone`
// role.
const grantFixedCore = (can: Can, user: AbilityUser) => {
  can('read', 'users', { id: user.id })

  // GDPR export (ADR 0013): every account exports itself. An export is seen
  // and fetched by the account that asked for it only.
  can('create', 'data-exports', { subjectId: user.id })
  can('read', 'data-exports', { requestedBy: user.id })
  // Checks the `data-exports` rule on the record itself.
  can('read', 'data-export-contents')

  // Checks the file's owner or the record attaching it, so it grants nothing
  // that a permission over files, documents or users does not (ADR 0020).
  can('read', 'file-contents')

  // Ending one's own view-as (ADR 0028), whatever one may do meanwhile;
  // `read` for feathers-casl's check of the result.
  can(['delete', 'read'], 'view-as')
}

const grantRoleManagement = (can: Can) => {
  can(['read', 'create', 'patch', 'delete'], 'roles')
  can(['read', 'patch'], 'user-roles')
}

type Rule = RawRuleOf<AppAbility>
const asList = (value: string | string[]) => [value].flat()

// feathers-casl narrows a result to the intersection of every field rule
// that matches it, whatever broader rule applies beside them. So a field
// rule is dropped where a rule without fields or conditions grants the same
// actions on the same subject: `sessions.read` beside
// `sessions.read-user-agent` reads every field, as CASL itself would have it.
const withoutShadowedFieldRules = (rules: Rule[]): Rule[] => {
  const broad = rules.filter((rule) => !rule.inverted && !rule.fields && !rule.conditions)
  const covers = (wide: Rule, narrow: Rule) =>
    asList(narrow.action).every((action) => asList(wide.action).includes(action)) &&
    asList(narrow.subject as string | string[]).every((name) => asList(wide.subject as string | string[]).includes(name))
  return rules.filter((rule) => rule.inverted || !rule.fields || !broad.some((wide) => covers(wide, rule)))
}

// Implied actions (ADR 0036): writing a subject implies reading it, and
// deleting implies changing it, each with the granting rule's conditions and
// fields. Patching does not imply creating. Aliases are spelled out first, so
// an entry granting `write` implies `read` and owns `create` and `patch`.
const IMPLIED: Record<string, readonly string[]> = { create: ['read'], patch: ['read'], delete: ['patch', 'read'] }
const ACTIONS_OF: Record<string, readonly string[]> = { write: ['create', 'patch'] }
const spelledOut = (action: string | string[]) => asList(action).flatMap((each) => ACTIONS_OF[each] ?? [each])

type CanArgs = Parameters<Can>

// Runs one catalogue entry's grant, then adds what its rules imply. An
// action the entry grants itself on a subject is never implied there, which
// is how an entry states a narrower read than its write would give
// (`sessions.revoke`). The fixed core and role management are not entries
// and get nothing implied.
export const grantEntry = (entry: PermissionEntry, can: Can, user: AbilityUser) => {
  const given: CanArgs[] = []
  const recording = ((...args: CanArgs) => {
    given.push(args)
    return can(...args)
  }) as Can
  entry.grant(recording, user)
  const own = new Set(given.flatMap(([action, subject]) => spelledOut(action).flatMap((each) => asList(subject as string | string[]).map((name) => `${each} ${name}`))))
  for (const [action, subject, ...rest] of given) {
    const implied = [...new Set(spelledOut(action).flatMap((each) => IMPLIED[each] ?? []))]
    for (const name of asList(subject as string | string[])) {
      for (const each of implied) {
        if (own.has(`${each} ${name}`)) continue
        ;(can as (...args: unknown[]) => unknown)(each, name, ...rest)
      }
    }
  }
}

export const defineAbilitiesFor = (user: AbilityUser): AppAbility => {
  const { can, rules } = new AbilityBuilder<AppAbility>(createMongoAbility)
  grantFixedCore(can, user)
  for (const key of user.permissions) {
    if (key === ROLE_MANAGEMENT) grantRoleManagement(can)
    // A key code no longer declares grants nothing (ADR 0011).
    else {
      const found = CATALOGUE.get(key)
      if (found) grantEntry(found, can, user)
    }
  }
  return createMongoAbility(withoutShadowedFieldRules(rules), { resolveAction })
}

const READ_ACTIONS = ['read', 'get', 'find']

// Read-only view-as (ADR 0028): the target's read rules, each kept only for
// a service the viewer reads every record of, with its fields narrowed to
// the viewer's. So a viewer never sees anything their own rights would not
// show them, and sees less than the target where their rights end. Every
// write is dropped, except ending the view-as. The browser builds the same
// ability to hide what it cannot show.
export const defineViewAsAbility = (viewer: AbilityUser, target: AbilityUser): AppAbility => {
  const mine = defineAbilitiesFor(viewer)
  const theirs = defineAbilitiesFor(target)
  const rules: Rule[] = []
  for (const rule of theirs.rules) {
    const actions = asList(rule.action).filter((action) => READ_ACTIONS.includes(action))
    if (rule.inverted || !actions.length) continue
    for (const name of asList(rule.subject as string | string[])) {
      const broad = mine.rulesFor('get', name).filter((own) => !own.inverted && !own.conditions)
      if (!broad.length) continue
      const viewerFields = broad.some((own) => !own.fields) ? undefined : [...new Set(broad.flatMap((own) => asList(own.fields ?? [])))]
      const fields = viewerFields ? (rule.fields ? asList(rule.fields).filter((field) => viewerFields.includes(field)) : viewerFields) : rule.fields
      if (fields && !fields.length) continue
      rules.push({
        action: actions,
        subject: name,
        ...(rule.conditions ? { conditions: rule.conditions } : {}),
        ...(fields ? { fields } : {})
      })
    }
  }
  rules.push({ action: ['delete', 'read'], subject: 'view-as' })
  return createMongoAbility(withoutShadowedFieldRules(rules), { resolveAction })
}

// API tokens (ADR 0029). What a token may never carry: tokens themselves,
// so a leaked one cannot mint successors; view-as, which is state of a
// browser session; and the irreversible or operational ones, which need a
// person in the UI (running the update check now among them, an outbound
// request a script should not repeat).
export const TOKEN_EXCLUDED_PERMISSIONS: readonly PermissionKey[] = [
  // One's own data stays with browser sessions (decided 2026-10-01).
  'profile.avatar',
  'profile.locale',
  'profile.preferences',
  'files.upload',
  'files.own',
  'audit-events.own',
  'roles.own-names',
  'api-tokens.own',
  'api-tokens.create',
  'api-tokens.manage',
  'users.view-as',
  'erasures.create',
  'settings.manage',
  'system-info.check',
  ...PRODUCT_TOKEN_EXCLUDED_PERMISSIONS
]
export const TOKEN_PERMISSION_KEYS: readonly PermissionKey[] = PERMISSION_KEYS.filter((key) => !TOKEN_EXCLUDED_PERMISSIONS.includes(key))
export const isTokenPermission = (key: string): boolean => (TOKEN_PERMISSION_KEYS as readonly string[]).includes(key)

// A token's ability: the permissions chosen for it that its owner still
// holds, and nothing else, not even the fixed core. Built on every request
// from the owner's current permissions, so it never exceeds them.
export const defineTokenAbility = (owner: AbilityUser, tokenPermissions: readonly string[]): AppAbility => {
  const held = new Set(owner.permissions)
  const { can, rules } = new AbilityBuilder<AppAbility>(createMongoAbility)
  for (const key of tokenPermissions) {
    const found = CATALOGUE.get(key)
    if (found && held.has(key) && isTokenPermission(key)) grantEntry(found, can, owner)
  }
  return createMongoAbility(withoutShadowedFieldRules(rules), { resolveAction })
}

// The permissions of the fixed `admin` role: the whole catalogue, including
// what is added later, and role management.
export const ADMIN_PERMISSIONS: readonly string[] = [...PERMISSION_KEYS, ROLE_MANAGEMENT]

// The services an ability reads every record of, whatever fields: the
// subject channels a connection joins (ADR 0012).
export const unconditionalReadSubjects = (ability: AppAbility): string[] => {
  const subjects = new Set<string>()
  for (const rule of ability.rules) {
    for (const name of [rule.subject].flat()) if (typeof name === 'string') subjects.add(name)
  }
  return [...subjects].filter((name) => ability.rulesFor('get', name).some((rule) => !rule.inverted && !rule.conditions))
}
