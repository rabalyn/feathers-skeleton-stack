import { describe, expect, it } from 'vitest'
import { findUpdates, lineOf, parseTag } from '../../src/system/versions.js'

// ADR 0032: image tags compared as versions. The tag lists are excerpts of
// the registries' real lists (2026-10-01), around the versions pinned then.

const POSTGRES = ['18', '18-alpine', '18.4-alpine', '18.6-alpine', '18.6-alpine3.22', '18.6-bookworm', '18.7-alpine', '18.7-alpine3.22', '19beta1-alpine', '19.0-alpine', '19.1-alpine', '17.11-alpine', 'latest', 'alpine']
const PROMETHEUS = ['v3.14.0', 'v3.15.0', 'v3.15.0-busybox', 'v3.15.0-distroless', 'v3.15.0-rc.0', 'v3.15.1-rc.1', 'v3.16.0-rc.0', 'v3', 'main', 'latest']
const NETBOX = ['v4.7.0-beta1', 'v4.7.0-beta1-5.0.2', 'v4.7.1', 'v4.7.1-5.1.1', 'v4.7.2', 'v4.7.2-5.1.1', 'v4.7.2-5.1.2', 'v4.8.0-5.2.0', 'v4.8.1-beta1-5.2.0', 'latest']
const NODE = ['24.21.0-trixie-slim', '24.21.0-trixie', '24.21.0-bookworm-slim', '24.22.0-trixie-slim', '25.9.0-trixie-slim', '26.10.0-trixie-slim', '26-trixie-slim', 'lts-trixie-slim']
const REDIS_EXPORTER = ['v1.92.0', 'v1.92.1', 'v1.93.0', 'v1.93.0-alpine', 'v1.93.0-arm64', 'v2.0.0-rc1']

describe('parseTag', () => {
  it('reads the optional v, the parts and the suffix', () => {
    expect(parseTag('18.6-alpine')).toMatchObject({ v: false, parts: [18, 6], suffix: '-alpine' })
    expect(parseTag('v1.92.0')).toMatchObject({ v: true, parts: [1, 92, 0], suffix: '' })
    expect(parseTag('24.21.0-trixie-slim')).toMatchObject({ parts: [24, 21, 0], suffix: '-trixie-slim' })
  })

  it('rejects what is not a version', () => {
    for (const tag of ['latest', 'alpine', 'main', 'lts-trixie-slim', '19beta1-alpine']) expect(parseTag(tag)).toBeNull()
  })

  it('reads an image revision only where the rule says so', () => {
    expect(parseTag('v4.7.2-5.1.1', { revision: true })).toMatchObject({ parts: [4, 7, 2], suffix: '', revision: [5, 1, 1] })
    expect(parseTag('v4.7.0-beta1-5.0.2', { revision: true })).toBeNull()
    expect(parseTag('v4.7.2', { revision: true })).toBeNull()
  })
})

describe('findUpdates', () => {
  it('finds the newest patch in the line and the newest major, with the same suffix only', () => {
    expect(findUpdates('18.6-alpine', POSTGRES, { lineDepth: 1 })).toEqual({ patch: '18.7-alpine', minor: null, major: '19.1-alpine' })
  })

  it('tells a newer minor line from a patch where lines have two parts', () => {
    expect(findUpdates('v1.92.0', REDIS_EXPORTER, { lineDepth: 2 })).toEqual({ patch: 'v1.92.1', minor: 'v1.93.0', major: null })
  })

  it('ignores pre-releases and variants', () => {
    expect(findUpdates('v3.15.0', PROMETHEUS, { lineDepth: 2 })).toEqual({ patch: null, minor: null, major: null })
  })

  it('compares an image revision after the version', () => {
    expect(findUpdates('v4.7.2-5.1.1', NETBOX, { lineDepth: 2, revision: true })).toEqual({
      patch: 'v4.7.2-5.1.2',
      minor: 'v4.8.0-5.2.0',
      major: null
    })
  })

  it('treats a one-part line as the major', () => {
    expect(findUpdates('24.21.0-trixie-slim', NODE, { lineDepth: 1 })).toEqual({
      patch: '24.22.0-trixie-slim',
      minor: null,
      major: '26.10.0-trixie-slim'
    })
  })

  it('reports nothing when the running version is the newest', () => {
    expect(findUpdates('19.1-alpine', POSTGRES, { lineDepth: 1 })).toEqual({ patch: null, minor: null, major: null })
  })

  it('refuses a running tag that is not a version', () => {
    expect(() => findUpdates('latest', POSTGRES, { lineDepth: 1 })).toThrow(/not a version tag/)
  })
})

describe('lineOf', () => {
  it('names the line as endoflife.date does', () => {
    expect(lineOf(parseTag('18.6-alpine')!, { lineDepth: 1 })).toBe('18')
    expect(lineOf(parseTag('9.1.2-alpine')!, { lineDepth: 2 })).toBe('9.1')
  })
})
