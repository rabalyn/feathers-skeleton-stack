import { describe, expect, it } from 'vitest'
import { attributeFilter, checkProductDirectory, searchFilter, tuIdFilter } from '../../src/directory.js'

// ADR 0008, 0018: every word is a prefix of one of four attributes, and
// nothing a user types can change the filter's structure.

describe('directory search filter', () => {
  it('requires every word to prefix one of the attributes', () => {
    expect(searchFilter('Uma Us')).toBe(
      '(&(objectClass=person)' +
        '(|(cn=Uma*)(givenName=Uma*)(sn=Uma*)(mail=Uma*))' +
        '(|(cn=Us*)(givenName=Us*)(sn=Us*)(mail=Us*)))'
    )
  })

  it('escapes filter syntax', () => {
    const filter = searchFilter(')(cn=*')
    expect(filter).toContain('(cn=\\29\\28cn=\\2a*)')
    expect(filter.match(/\(/g)?.length).toBe(filter.match(/\)/g)?.length)
  })

  it('ignores surplus whitespace and caps the number of words', () => {
    expect(searchFilter('  ab  ')).toBe('(&(objectClass=person)(|(cn=ab*)(givenName=ab*)(sn=ab*)(mail=ab*)))')
    expect(searchFilter('a b c d e f').match(/\(\|/g)).toHaveLength(4)
  })
})

describe('directory lookup by TU-ID (ADR 0009)', () => {
  it('matches the TU-ID exactly, with filter syntax as text', () => {
    expect(tuIdFilter('bk001blk')).toBe('(&(objectClass=person)(cn=bk001blk))')
    expect(tuIdFilter('*')).toBe('(&(objectClass=person)(cn=\\2a))')
    const filter = tuIdFilter('x)(cn=*')
    expect(filter).toBe('(&(objectClass=person)(cn=x\\29\\28cn=\\2a))')
  })
})

describe('directory lookup by an attribute the product names (ADR 0008)', () => {
  it('matches the value exactly, with filter syntax as text', () => {
    expect(attributeFilter('idmUserAssignedCardSnMifare', '0412A0')).toBe('(&(objectClass=person)(idmUserAssignedCardSnMifare=0412A0))')
    expect(attributeFilter('x', '*)(cn=*')).toBe('(&(objectClass=person)(x=\\2a\\29\\28cn=\\2a))')
  })

  it('refuses several people holding one value, and finds nobody for none', async () => {
    const { DirectoryLookupService } = await import('../../src/services/directory/directory-lookups.js')
    const entry = (tuId: string) => ({ tuId, givenName: null, surname: null, email: null })
    const knex = () => ({ where: () => ({ first: async () => undefined }) })
    const service = (entries: unknown[]) =>
      new DirectoryLookupService({ findBy: async () => entries } as never, knex as never, { cardNumber: 'card' })
    await expect(service([entry('a'), entry('b')]).create({ by: 'cardNumber', value: '1' })).rejects.toMatchObject({ code: 409 })
    await expect(service([]).create({ by: 'cardNumber', value: '1' })).rejects.toMatchObject({ code: 404 })
    await expect(service([entry('a')]).create({ by: 'cardNumber', value: '1' })).resolves.toEqual({ ...entry('a'), userId: null })
  })
})

describe('directory service paging', () => {
  it('passes on that the directory had more matches than one search returns', async () => {
    const { DirectoryService } = await import('../../src/services/directory/directory.js')
    const entries = Array.from({ length: 50 }, (_, i) => ({
      tuId: `bulk${String(i).padStart(4, '0')}`,
      givenName: null,
      surname: null,
      email: null
    }))
    const directory = { search: async () => ({ entries, truncated: true }) }
    const knex = () => ({ whereIn: () => ({ select: async () => [] }) })
    const service = new DirectoryService(directory as never, knex as never)
    const page = await service.find({ query: { q: 'bulk', $limit: 10, $skip: 45 } })
    expect(page).toMatchObject({ total: 50, limit: 10, skip: 45, truncated: true })
    expect(page.data.map((e) => e.tuId)).toEqual(['bulk0045', 'bulk0046', 'bulk0047', 'bulk0048', 'bulk0049'])
  })

  it('never answers more than 50 entries per page', async () => {
    const { DirectoryService } = await import('../../src/services/directory/directory.js')
    const entries = Array.from({ length: 100 }, (_, i) => ({ tuId: `b${i}`, givenName: null, surname: null, email: null }))
    const directory = { search: async () => ({ entries, truncated: true }) }
    const knex = () => ({ whereIn: () => ({ select: async () => [] }) })
    const service = new DirectoryService(directory as never, knex as never)
    const page = await service.find({ query: { q: 'b0', $limit: 100 } })
    expect(page).toMatchObject({ total: 100, limit: 50 })
    expect(page.data).toHaveLength(50)
  })
})

describe("a product's further attributes (ADR 0008)", () => {
  const check = (attributes: string[]) => () => checkProductDirectory({ attributes, apply: async () => {} })
  const checkLookups = (lookups: Record<string, string>) => () => checkProductDirectory({ attributes: [], apply: async () => {}, lookups })

  it('takes lookups by an identifier of the product and an attribute name', () => {
    expect(checkLookups({ cardNumber: 'idmUserAssignedCardSnMifare', mail: 'mail' })).not.toThrow()
  })

  it.each([
    ['a name that is no identifier', { 'card-number': 'x' }],
    ['no attribute name', { cardNumber: 'x;binary' }],
    ['the password', { secret: 'UserPassword' }]
  ])('refuses a lookup with %s', (_case, lookups) => {
    expect(checkLookups(lookups)).toThrow(/product directory lookup/)
  })

  it('takes attribute names', () => {
    expect(check(['ou', 'groupMembership', 'x-custom-1'])).not.toThrow()
  })

  it.each([
    ['no attribute name', ['ou;binary']],
    ['an account field', ['givenName']],
    ['the TU-ID, in any case', ['CN']],
    ['the password', ['userPassword']],
    ['a name twice', ['ou', 'OU']]
  ])('refuses %s', (_case, attributes) => {
    expect(check(attributes)).toThrow(/product directory attribute/)
  })
})
