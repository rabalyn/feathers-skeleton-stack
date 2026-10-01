import { describe, expect, it } from 'vitest'
import type { GetOptions, Response } from '../../src/system/http.js'
import { MAX_TAG_PAGES, UPDATE_CHECK_HOSTS, internetSources } from '../../src/system/update-sources.js'

// ADR 0032: the update check reaches the registries and endoflife.date only,
// follows the registries' next-page links only within that allowlist, and
// bounds how many pages it reads.

const fakeGet = (respond: (url: URL) => Response) => {
  const asked: URL[] = []
  const get = async (url: URL, _options?: GetOptions) => {
    asked.push(url)
    return respond(url)
  }
  return { get, asked }
}

const ok = (body: unknown, headers: Response['headers'] = {}): Response => ({ status: 200, headers, body: JSON.stringify(body) })

describe('internetSources', () => {
  it('lists Docker Hub tags with an anonymous token, page by page', async () => {
    const { get, asked } = fakeGet((url) => {
      if (url.hostname === 'auth.docker.io') return ok({ token: 't' })
      if (!url.searchParams.has('last')) {
        return ok({ tags: ['18.6-alpine'] }, { link: '</v2/library/postgres/tags/list?last=18.6-alpine&n=1000>; rel="next"' })
      }
      return ok({ tags: ['18.7-alpine'] })
    })
    expect(await internetSources(get).tags('docker.io/library/postgres')).toEqual(['18.6-alpine', '18.7-alpine'])
    expect(asked.map((url) => url.hostname)).toEqual(['auth.docker.io', 'registry-1.docker.io', 'registry-1.docker.io'])
    expect(asked.every((url) => (UPDATE_CHECK_HOSTS as readonly string[]).includes(url.hostname))).toBe(true)
  })

  it('refuses a next-page link to a host off the allowlist', async () => {
    const { get, asked } = fakeGet(() => ok({ tags: ['v1.0.0'] }, { link: '<https://evil.example/v2/x/tags/list?last=a>; rel="next"' }))
    await expect(internetSources(get).tags('quay.io/prometheus/node-exporter')).rejects.toThrow(/allowlist/)
    expect(asked.map((url) => url.hostname)).toEqual(['quay.io'])
  })

  it('stops after a bounded number of pages', async () => {
    const { get, asked } = fakeGet(() => ok({ tags: ['x'] }, { link: '</v2/a/b/tags/list?last=x&n=1000>; rel="next"' }))
    await expect(internetSources(get).tags('quay.io/a/b')).rejects.toThrow(/more than/)
    expect(asked).toHaveLength(MAX_TAG_PAGES)
  })

  it('asks only the registries it knows', async () => {
    const { get, asked } = fakeGet(() => ok({}))
    await expect(internetSources(get).tags('ghcr.io/someone/thing')).rejects.toThrow(/no registry/)
    expect(asked).toHaveLength(0)
  })

  it('reads end-of-life cycles from endoflife.date for a plain product name only', async () => {
    const { get, asked } = fakeGet(() => ok([{ cycle: '18', eol: '2030-11-14' }]))
    expect(await internetSources(get).cycles('postgresql')).toEqual([{ cycle: '18', eol: '2030-11-14' }])
    await expect(internetSources(get).cycles('../etc')).rejects.toThrow(/not a product name/)
    expect(asked.map((url) => url.href)).toEqual(['https://endoflife.date/api/postgresql.json'])
  })
})
