import { describe, expect, it } from 'vitest'
import { describeUserAgent } from '@/api/user-agent'

describe('describeUserAgent', () => {
  it('names the common browsers and systems', () => {
    expect(describeUserAgent('Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0')).toBe('Firefox · Linux')
    expect(
      describeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0')
    ).toBe('Edge · Windows')
    expect(
      describeUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15')
    ).toBe('Safari · macOS')
    expect(
      describeUserAgent('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36')
    ).toBe('Chrome · Android')
    expect(
      describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')
    ).toBe('Safari · iOS')
  })

  it('shows anything else as recorded, and nothing as nothing', () => {
    expect(describeUserAgent('curl/8.10.1')).toBe('curl/8.10.1')
    expect(describeUserAgent(null)).toBeNull()
    expect(describeUserAgent(undefined)).toBeNull()
  })
})
