import { subject } from '@casl/ability'
import { describe, expect, it } from 'vitest'
import {
  ADMIN_PERMISSIONS,
  PERMISSIONS,
  TOKEN_PERMISSION_KEYS,
  defineAbilitiesFor,
  defineTokenAbility,
  defineViewAsAbility,
  unconditionalReadSubjects
} from '../../src/abilities.js'

// ADR 0011: the permission catalogue. Each entry grants something, rules of
// several permissions add up, and field rules narrow only where no broader
// rule applies.

const ability = (permissions: readonly string[]) => defineAbilitiesFor({ id: 'me', permissions, roleIds: ['r1'] })

describe('the permission catalogue', () => {
  it.each(PERMISSIONS.map((entry) => entry.key))('%s grants something beyond the fixed core', (key) => {
    expect(ability([key]).rules.length).toBeGreaterThan(ability([]).rules.length)
  })

  it('has unique keys', () => {
    const keys = PERMISSIONS.map((entry) => entry.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('ignores a key it does not declare', () => {
    expect(ability(['nope']).rules).toEqual(ability([]).rules)
  })
})

describe('field rules add up', () => {
  it('leaves no field rule beside a broader one, which feathers-casl would intersect', () => {
    const fieldRules = (permissions: readonly string[], name: string) =>
      ability(permissions).rules.filter((rule) => rule.fields && [rule.subject].flat().includes(name))
    expect(fieldRules(ADMIN_PERMISSIONS, 'sessions')).toEqual([])
    expect(fieldRules(ADMIN_PERMISSIONS, 'roles')).toEqual([])
    expect(fieldRules(['sessions.read', 'sessions.read-user-agent'], 'sessions')).toEqual([])
    expect(fieldRules(['sessions.read'], 'sessions')).toHaveLength(1)
  })

  it('sessions.read hides the user agent, with read-user-agent it shows', () => {
    const session = subject('sessions', { id: 's', userId: 'u' })
    expect(ability(['sessions.read']).can('read', session, 'userAgent')).toBe(false)
    expect(ability(['sessions.read', 'sessions.read-user-agent']).can('read', session, 'userAgent')).toBe(true)
    expect(ability(['sessions.read', 'sessions.read-user-agent', 'sessions.revoke']).can('read', session, 'userAgent')).toBe(true)
    expect(ability(ADMIN_PERMISSIONS).can('read', session, 'userAgent')).toBe(true)
  })

  it('users.read shows role names only, role management everything', () => {
    const role = subject('roles', { id: 'r2', key: 'x' })
    expect(ability(['users.read']).can('read', role, 'name')).toBe(true)
    expect(ability(['users.read']).can('read', role, 'permissions')).toBe(false)
    expect(ability(ADMIN_PERMISSIONS).can('read', role, 'permissions')).toBe(true)
  })

  it('roles.own-names reads the names of the own roles only', () => {
    const own = ability(['roles.own-names'])
    expect(own.can('read', subject('roles', { id: 'r1' }), 'name')).toBe(true)
    expect(own.can('read', subject('roles', { id: 'r1' }), 'permissions')).toBe(false)
    expect(own.can('read', subject('roles', { id: 'r2' }), 'name')).toBe(false)
    expect(ability([]).can('read', subject('roles', { id: 'r1' }), 'name')).toBe(false)
  })
})

// ADR 0011, decided 2026-10-01: what no role can withdraw.
describe('the fixed core', () => {
  const core = ability([])

  it('keeps the own record, the own export and ending a view-as', () => {
    expect(core.can('read', subject('users', { id: 'me' }))).toBe(true)
    expect(core.can('read', subject('users', { id: 'other' }))).toBe(false)
    expect(core.can('create', subject('data-exports', { subjectId: 'me' }))).toBe(true)
    expect(core.can('create', subject('data-exports', { subjectId: 'other' }))).toBe(false)
    expect(core.can('read', subject('data-exports', { requestedBy: 'me' }))).toBe(true)
    expect(core.can('read', 'data-export-contents')).toBe(true)
    expect(core.can('remove', 'view-as')).toBe(true)
  })

  it('leaves everything else of one\'s own to the catalogue', () => {
    expect(core.can('create', 'avatars')).toBe(false)
    expect(core.can('create', 'locales')).toBe(false)
    expect(core.can('create', 'files')).toBe(false)
    expect(core.can('read', subject('files', { ownerId: 'me' }))).toBe(false)
    expect(core.can('read', subject('audit-events', { actorId: 'me' }))).toBe(false)
    expect(core.can('read', subject('api-tokens', { userId: 'me' }))).toBe(false)
    expect(core.can('remove', subject('api-tokens', { userId: 'me' }))).toBe(false)
  })
})

describe('subject channels', () => {
  it('are the services read without conditions', () => {
    expect(unconditionalReadSubjects(ability([])).sort()).toEqual(['data-export-contents', 'file-contents', 'view-as'])
    expect(unconditionalReadSubjects(ability(['profile.avatar', 'profile.locale']))).toEqual(expect.arrayContaining(['avatars', 'locales']))
    expect(unconditionalReadSubjects(ability(['documents.own']))).not.toContain('documents')
    expect(unconditionalReadSubjects(ability(['documents.all']))).toContain('documents')
    expect(unconditionalReadSubjects(ability(['users.read']))).toEqual(expect.arrayContaining(['users', 'roles']))
    // Files are read through what attaches them (ADR 0020), never wholesale.
    expect(unconditionalReadSubjects(ability(['users.read', 'documents.all']))).not.toContain('files')
  })
})

describe('view-as (ADR 0028)', () => {
  const viewer = (permissions: readonly string[]) => ({ id: 'viewer', permissions, roleIds: ['v'] })
  const target = (permissions: readonly string[]) => ({ id: 'target', permissions, roleIds: ['t'] })

  it("shows the target's own documents to a viewer who reads every document, read-only", () => {
    const seen = defineViewAsAbility(viewer(['documents.all', 'users.read']), target(['documents.own']))
    expect(seen.can('read', subject('documents', { ownerId: 'target' }))).toBe(true)
    expect(seen.can('read', subject('documents', { ownerId: 'someone' }))).toBe(false)
    expect(seen.can('create', 'documents')).toBe(false)
    expect(seen.can('patch', subject('documents', { ownerId: 'target' }))).toBe(false)
    expect(seen.can('read', subject('users', { id: 'target' }))).toBe(true)
  })

  it('never shows the viewer more than their own rights would', () => {
    const seen = defineViewAsAbility(viewer(['users.read']), target(ADMIN_PERMISSIONS))
    expect(seen.can('read', 'settings')).toBe(false)
    expect(seen.can('read', 'documents')).toBe(false)
    // The target's own activity needs the viewer to read everybody's.
    expect(seen.can('read', subject('audit-events', { actorId: 'target' }))).toBe(false)
    expect(defineViewAsAbility(viewer(['audit-events.read']), target(['audit-events.own'])).can('read', subject('audit-events', { actorId: 'target' }))).toBe(
      true
    )
  })

  it("narrows fields to the viewer's", () => {
    const seen = defineViewAsAbility(viewer(['sessions.read']), target(['sessions.read', 'sessions.read-user-agent']))
    expect(seen.can('read', subject('sessions', { id: 's' }), 'lastUsedAt')).toBe(true)
    expect(seen.can('read', subject('sessions', { id: 's' }), 'userAgent')).toBe(false)
  })

  it("hides the target's exports, which only their requester ever sees, and allows nothing but ending the view", () => {
    const seen = defineViewAsAbility(viewer(ADMIN_PERMISSIONS), target(['documents.own']))
    expect(seen.can('read', subject('data-exports', { requestedBy: 'target' }))).toBe(false)
    expect(seen.can('create', 'view-as')).toBe(false)
    expect(seen.can('create', 'roles')).toBe(false)
    expect(seen.can('delete', 'view-as')).toBe(true)
  })
})

describe('API tokens (ADR 0029)', () => {
  const owner = (permissions: readonly string[]) => ({ id: 'owner', permissions, roleIds: ['o'] })

  it('grants the chosen permissions, writes included, and no fixed core', () => {
    const token = defineTokenAbility(owner(ADMIN_PERMISSIONS), ['documents.own'])
    expect(token.can('create', 'documents')).toBe(true)
    expect(token.can('patch', subject('documents', { ownerId: 'owner' }))).toBe(true)
    expect(token.can('read', subject('users', { id: 'owner' }))).toBe(false)
    expect(token.can('read', subject('api-tokens', { userId: 'owner' }))).toBe(false)
    expect(token.can('create', 'files')).toBe(false)
    expect(token.can('create', 'roles')).toBe(false)
  })

  it("grants nothing its owner no longer holds, and nothing a token may not carry", () => {
    expect(defineTokenAbility(owner(['documents.own']), ['users.read']).can('read', 'users')).toBe(false)
    const excluded = defineTokenAbility(owner(ADMIN_PERMISSIONS), ['settings.manage', 'api-tokens.create', 'users.view-as', 'erasures.create', 'system-info.check'])
    expect(excluded.rules).toEqual([])
    expect(TOKEN_PERMISSION_KEYS).not.toContain('api-tokens.manage')
  })

  it('lets api-tokens.own see and revoke one\'s own tokens, and api-tokens.manage everybody\'s', () => {
    expect(ability(['api-tokens.own']).can('delete', subject('api-tokens', { userId: 'me' }))).toBe(true)
    expect(ability(['api-tokens.own']).can('read', subject('api-tokens', { userId: 'other' }))).toBe(false)
    expect(ability([]).can('create', 'api-tokens')).toBe(false)
    expect(ability(['api-tokens.create']).can('create', 'api-tokens')).toBe(true)
    expect(ability(['api-tokens.manage']).can('delete', subject('api-tokens', { userId: 'other' }))).toBe(true)
  })
})
