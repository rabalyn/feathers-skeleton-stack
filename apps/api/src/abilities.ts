import { AbilityBuilder, createAliasResolver, createMongoAbility, type MongoAbility, type RawRuleOf } from '@casl/ability'

// Authorization (ADR 0011): the one module where rules live. Permissions are
// declared here, in the catalogue; roles, which an admin composes from them,
// are rows in the database. It is imported by the browser through the client
// entry point to hide actions, so it must import nothing but @casl/ability
// (ADR 0007). The server remains the only enforcement point.

export type AppAbility = MongoAbility

// Who an ability is for: the account, and the permission keys its roles add
// up to (loaded per request, ADR 0010).
export interface AbilityUser {
  id: string
  permissions: readonly string[]
  // The roles themselves, whose names the account may always read.
  roleIds?: readonly string[]
}

type Can = AbilityBuilder<AppAbility>['can']

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

export interface PermissionEntry {
  key: string
  // The permissions page shows the catalogue grouped by this; its label is
  // the web app's translation `permissions.groups.<group>`.
  group: string
  grant: (can: Can, user: AbilityUser) => void
}

// The permission catalogue (ADR 0011). A product adds entries for its own
// resources; the web app translates `permissions.keys.<key>` and
// `permissions.descriptions.<key>`. A key is stable once released: roles
// store it.
type Grant = PermissionEntry['grant']
const entry = <K extends string>(key: K, group: string, grant: Grant): PermissionEntry & { key: K } => ({ key, group, grant })

const CATALOGUE_ENTRIES = [
  entry('users.read', 'users', (can) => {
    can('read', 'users')
    // Their avatars. Files carry no mark of what they are attached to, so
    // this reaches every file whose id the reader knows.
    can('read', 'files')
    can('read', 'roles', ROLE_NAME_FIELDS)
  }),
  // Which fields a patch may carry is fixed by the users patch schema.
  entry('users.enable', 'users', (can) => can('patch', 'users')),
  entry('directory.read', 'users', (can) => can('read', 'directory')),
  // Locations (ADR 0031): the university's buildings, from NetBox.
  entry('sites.read', 'locations', (can) => can('read', 'sites')),
  // Read-only view as another person, bounded by one's own rights (ADR 0028).
  // `read` for feathers-casl's check of the create's result.
  entry('users.view-as', 'users', (can) => can(['create', 'read'], 'view-as')),
  // The caller always becomes the owner of what they create; lists are
  // scoped by the same condition.
  entry('documents.own', 'documents', (can, user) => {
    can('create', 'documents')
    can(['read', 'write', 'delete'], 'documents', { ownerId: user.id })
  }),
  entry('documents.all', 'documents', (can) => {
    can(['read', 'write', 'delete'], 'documents')
    can('read', 'files')
  }),
  entry('sessions.read', 'sessions', (can) => can('read', 'sessions', SESSION_FIELDS_WITHOUT_USER_AGENT)),
  entry('sessions.read-user-agent', 'sessions', (can) => can('read', 'sessions')),
  // `read` beside `delete`: feathers-casl checks the removed record.
  entry('sessions.revoke', 'sessions', (can) => {
    can('delete', 'sessions')
    can('read', 'sessions', SESSION_FIELDS_WITHOUT_USER_AGENT)
  }),
  entry('audit-events.read', 'privacy', (can) => can('read', 'audit-events')),
  entry('data-exports.any', 'privacy', (can) => can('create', 'data-exports')),
  // `read` for feathers-casl's check of the create's result.
  entry('erasures.create', 'privacy', (can) => can(['create', 'read'], 'erasures')),
  entry('settings.manage', 'configuration', (can) => can(['read', 'patch'], 'settings')),
  // `read` on previews for feathers-casl's check of the create's result.
  entry('mail.manage', 'configuration', (can) => {
    can('read', 'mail-kinds')
    can(['read', 'patch'], 'mail-templates')
    can(['read', 'create'], 'mail-template-revisions')
    can(['create', 'read'], 'mail-previews')
    can(['read', 'create'], 'mail-campaigns')
    can(['create', 'read'], 'mail-campaign-previews')
    can('read', 'mail-deliveries')
  }),
  entry('queues.read', 'configuration', (can) => can('read', 'queues')),
  // API tokens (ADR 0029): creating one's own, bounded by one's own rights
  // on every request; seeing and revoking one's own is the baseline.
  entry('api-tokens.create', 'api', (can) => can('create', 'api-tokens')),
  entry('api-tokens.manage', 'api', (can) => can(['read', 'delete'], 'api-tokens')),
  // gen:service permissions (ADR 0030)
]

export type PermissionKey = (typeof CATALOGUE_ENTRIES)[number]['key']
export const PERMISSIONS: readonly (PermissionEntry & { key: PermissionKey })[] = CATALOGUE_ENTRIES
export const PERMISSION_KEYS: readonly PermissionKey[] = PERMISSIONS.map((entry) => entry.key)
const CATALOGUE = new Map<string, PermissionEntry>(PERMISSIONS.map((entry) => [entry.key, entry]))

export const isPermissionKey = (key: string): key is PermissionKey => CATALOGUE.has(key)

// Role management: `admin`'s alone and outside the catalogue, so no role can
// be granted it (ADR 0011). Only the fixed `admin` role yields this key.
export const ROLE_MANAGEMENT = 'roles.manage'

// The kinds of role (ADR 0011).
export const ROLE_KINDS = ['admin', 'seeded', 'custom'] as const
export type RoleKind = (typeof ROLE_KINDS)[number]

// What every signed-in account may do, whatever its roles: its own record,
// avatar, locale and files, its own GDPR export, its own audit events and
// the names of its own roles.
// No role can withdraw it (ADR 0011, 0013).
const grantBaseline = (can: Can, user: AbilityUser) => {
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

  // GDPR export (ADR 0013): every account exports itself. An export is seen
  // and fetched by the account that asked for it only.
  can('create', 'data-exports', { subjectId: user.id })
  can('read', 'data-exports', { requestedBy: user.id })
  // Checks the `data-exports` rule on the record itself, like file-contents.
  can('read', 'data-export-contents')

  // Audit events (ADR 0011, 0013): what the caller did.
  can('read', 'audit-events', { actorId: user.id })

  // Ending one's own view-as (ADR 0028), whatever one may do meanwhile;
  // `read` for feathers-casl's check of the result.
  can(['delete', 'read'], 'view-as')

  // One's own API tokens, to see and revoke even after losing the right to
  // create them (ADR 0029).
  can(['read', 'delete'], 'api-tokens', { userId: user.id })

  // The names of the caller's own roles, shown on their profile.
  if (user.roleIds?.length) can('read', 'roles', ROLE_NAME_FIELDS, { id: { $in: [...user.roleIds] } })
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

export const defineAbilitiesFor = (user: AbilityUser): AppAbility => {
  const { can, rules } = new AbilityBuilder<AppAbility>(createMongoAbility)
  grantBaseline(can, user)
  for (const key of user.permissions) {
    if (key === ROLE_MANAGEMENT) grantRoleManagement(can)
    // A key code no longer declares grants nothing (ADR 0011).
    else CATALOGUE.get(key)?.grant(can, user)
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
// person in the UI.
export const TOKEN_EXCLUDED_PERMISSIONS: readonly PermissionKey[] = [
  'api-tokens.create',
  'api-tokens.manage',
  'users.view-as',
  'erasures.create',
  'settings.manage'
]
export const TOKEN_PERMISSION_KEYS: readonly PermissionKey[] = PERMISSION_KEYS.filter((key) => !TOKEN_EXCLUDED_PERMISSIONS.includes(key))
export const isTokenPermission = (key: string): boolean => (TOKEN_PERMISSION_KEYS as readonly string[]).includes(key)

// A token's ability: the permissions chosen for it that its owner still
// holds, and nothing else, not even the baseline. Built on every request
// from the owner's current permissions, so it never exceeds them.
export const defineTokenAbility = (owner: AbilityUser, tokenPermissions: readonly string[]): AppAbility => {
  const held = new Set(owner.permissions)
  const { can, rules } = new AbilityBuilder<AppAbility>(createMongoAbility)
  for (const key of tokenPermissions) {
    if (held.has(key) && isTokenPermission(key)) CATALOGUE.get(key)?.grant(can, owner)
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
