import { describe, expect, it } from 'vitest'
import { arrange, moved } from '@/composables/order'

const links = ['profile', 'documents', 'users', 'settings'].map((name) => ({ name }))
const names = (list: { name: string }[]) => list.map((link) => link.name)

describe('arrange', () => {
  it('keeps the default order without a stored one', () => {
    expect(names(arrange(links, null))).toEqual(['profile', 'documents', 'users', 'settings'])
    expect(names(arrange(links, []))).toEqual(['profile', 'documents', 'users', 'settings'])
  })

  it('follows the stored order and skips names not shown', () => {
    expect(names(arrange(links, ['settings', 'gone', 'users', 'profile', 'documents']))).toEqual([
      'settings',
      'users',
      'profile',
      'documents'
    ])
  })

  it('puts a link the order does not name after its default predecessor', () => {
    expect(names(arrange(links, ['settings', 'documents', 'profile']))).toEqual(['settings', 'documents', 'users', 'profile'])
    // The first link by default goes first.
    expect(names(arrange(links, ['users', 'settings', 'documents']))).toEqual(['profile', 'users', 'settings', 'documents'])
  })
})

describe('moved', () => {
  it('moves one name and leaves the rest in order', () => {
    expect(moved(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(moved(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c'])
  })

  it('ignores a move out of range', () => {
    expect(moved(['a', 'b'], 0, -1)).toEqual(['a', 'b'])
    expect(moved(['a', 'b'], 5, 0)).toEqual(['a', 'b'])
  })
})
