import { describe, expect, it } from 'vitest'
import { searchFilter } from '../../src/directory.js'

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
})
