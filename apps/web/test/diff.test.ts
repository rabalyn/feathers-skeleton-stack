import { describe, expect, it } from 'vitest'
import { diffLines } from '@/composables/diff'

describe('diffLines', () => {
  it('keeps common lines and marks removed and added ones in order', () => {
    expect(diffLines('a\nb\nc', 'a\nx\nc\nd')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'x' },
      { kind: 'same', text: 'c' },
      { kind: 'added', text: 'd' }
    ])
  })

  it('handles identical and empty texts', () => {
    expect(diffLines('a', 'a')).toEqual([{ kind: 'same', text: 'a' }])
    expect(diffLines('', 'a')).toEqual([
      { kind: 'removed', text: '' },
      { kind: 'added', text: 'a' }
    ])
  })
})
