import type { SystemConfig } from '../config.js'
import { SourceError, getText, type GetOptions } from './http.js'
import { Prometheus, type Labels } from './prometheus.js'

// The update check's sources on the internet (ADR 0032): the image
// registries' tag lists and endoflife.date. The hosts are a fixed allowlist;
// a URL to any other host, a next-page link included, is refused before a
// connection is made.

export const UPDATE_CHECK_HOSTS = ['registry-1.docker.io', 'auth.docker.io', 'quay.io', 'endoflife.date'] as const

// One run lists at most this many pages of 1000 tags per repository. Loki's
// list is about 28 pages, almost all branch builds; versions sort before
// them (the registries list tags in lexical order).
export const MAX_TAG_PAGES = 40

export interface Cycle {
  cycle: string
  // A date, or false while none is announced (true: reached, no date).
  eol: string | boolean
}

export interface UpdateSources {
  tags(image: string): Promise<string[]>
  cycles(product: string): Promise<Cycle[]>
}

type Get = (url: URL, options?: GetOptions) => ReturnType<typeof getText>

const allowed = (url: URL) => {
  if (url.protocol !== 'https:' || !(UPDATE_CHECK_HOSTS as readonly string[]).includes(url.hostname) || url.port) {
    throw new SourceError(`refusing ${url.origin}: not on the update check's allowlist`)
  }
  return url
}

const json = <T>(body: string, host: string): T => {
  try {
    return JSON.parse(body) as T
  } catch {
    throw new SourceError(`${host} sent no JSON`)
  }
}

// `<…>; rel="next"`, relative to the registry.
const nextPage = (link: string | string[] | undefined, base: URL): URL | null => {
  const header = Array.isArray(link) ? link.join(',') : link
  const match = header ? /<([^>]+)>;\s*rel="next"/.exec(header) : null
  return match ? allowed(new URL(match[1]!, base)) : null
}

export const internetSources = (get: Get = getText): UpdateSources => ({
  async tags(image) {
    const [host, ...rest] = image.split('/')
    const repository = rest.join('/')
    let registry: URL
    const headers: Record<string, string> = {}
    if (host === 'docker.io') {
      registry = new URL('https://registry-1.docker.io')
      // Docker Hub wants an anonymous token even for public repositories.
      const auth = allowed(new URL('https://auth.docker.io/token'))
      auth.searchParams.set('service', 'registry.docker.io')
      auth.searchParams.set('scope', `repository:${repository}:pull`)
      const response = await get(auth)
      if (response.status !== 200) throw new SourceError(`auth.docker.io answered ${response.status}`)
      headers.Authorization = `Bearer ${json<{ token: string }>(response.body, 'auth.docker.io').token}`
    } else if (host === 'quay.io') {
      registry = new URL('https://quay.io')
    } else {
      throw new SourceError(`no registry for ${image}`)
    }
    const tags: string[] = []
    let url: URL | null = allowed(new URL(`/v2/${repository}/tags/list?n=1000`, registry))
    for (let page = 0; url; page++) {
      if (page === MAX_TAG_PAGES) throw new SourceError(`${image}: more than ${MAX_TAG_PAGES} pages of tags`)
      const response = await get(url, { headers })
      if (response.status !== 200) throw new SourceError(`${url.hostname} answered ${response.status} for ${repository}`)
      tags.push(...(json<{ tags?: string[] | null }>(response.body, url.hostname).tags ?? []))
      url = nextPage(response.headers.link, registry)
    }
    return tags
  },

  async cycles(product) {
    if (!/^[a-z0-9-]+$/.test(product)) throw new SourceError(`not a product name: ${product}`)
    const url = allowed(new URL(`https://endoflife.date/api/${product}.json`))
    const response = await get(url)
    if (response.status !== 200) throw new SourceError(`endoflife.date answered ${response.status} for ${product}`)
    return json<Cycle[]>(response.body, url.hostname)
  }
})

// What the worker's update check uses, or nothing while it is off.
export const updateCheckSources = (config: SystemConfig) => {
  if (config.updateCheck !== 'on') return undefined
  const prometheus = new Prometheus(config)
  return {
    sources: internetSources(),
    hostOs: async (): Promise<Labels | null> => (await prometheus.series('node_os_info'))[0] ?? null
  }
}
