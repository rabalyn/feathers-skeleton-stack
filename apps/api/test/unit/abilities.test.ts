import { subject } from '@casl/ability'
import { describe, expect, it } from 'vitest'
import { ADMIN_PERMISSIONS, PERMISSIONS, defineAbilitiesFor, unconditionalReadSubjects } from '../../src/abilities.js'

// ADR 0011: the permission catalogue. Each entry grants something, rules of
// several permissions add up, and field rules narrow only where no broader
// rule applies.

const ability = (permissions: readonly string[]) => defineAbilitiesFor({ id: 'me', permissions, roleIds: ['r1'] })

describe('the permission catalogue', () => {
  it.each(PERMISSIONS.map((entry) => entry.key))('%s grants something beyond the baseline', (key) => {
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

  it('the baseline reads the names of the own roles only', () => {
    expect(ability([]).can('read', subject('roles', { id: 'r1' }), 'name')).toBe(true)
    expect(ability([]).can('read', subject('roles', { id: 'r1' }), 'permissions')).toBe(false)
    expect(ability([]).can('read', subject('roles', { id: 'r2' }), 'name')).toBe(false)
  })
})

describe('subject channels', () => {
  it('are the services read without conditions', () => {
    expect(unconditionalReadSubjects(ability([])).sort()).toEqual(['avatars', 'data-export-contents', 'file-contents', 'locales'])
    expect(unconditionalReadSubjects(ability(['documents.own']))).not.toContain('documents')
    expect(unconditionalReadSubjects(ability(['documents.all']))).toContain('documents')
    expect(unconditionalReadSubjects(ability(['users.read']))).toEqual(expect.arrayContaining(['users', 'files', 'roles']))
  })
})
