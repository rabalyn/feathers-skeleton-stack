import { readFileSync } from 'node:fs'
import type { SystemConfig } from '../config.js'
import { SourceError, getJson } from './http.js'

// Prometheus' query API (ADR 0032): most components report their version as
// a label of an `_info` series, which Prometheus already scrapes
// (ADR 0022). Read over TLS verified against the CA root.

export type Labels = Record<string, string>

interface QueryResponse {
  status: string
  data?: { resultType: string; result: { metric: Labels }[] }
}

const TIMEOUT_MS = 3000

export class Prometheus {
  private readonly ca: string

  constructor(private readonly config: Pick<SystemConfig, 'prometheusUrl' | 'prometheusCaFile'>) {
    this.ca = readFileSync(config.prometheusCaFile, 'utf8')
  }

  // The label sets of the series an instant query returns.
  async series(query: string): Promise<Labels[]> {
    const url = new URL('/api/v1/query', this.config.prometheusUrl)
    url.searchParams.set('query', query)
    const response = await getJson<QueryResponse>(url, { ca: this.ca, timeoutMs: TIMEOUT_MS, maxBytes: 1024 * 1024 })
    if (response.status !== 'success' || response.data?.resultType !== 'vector') {
      throw new SourceError(`Prometheus could not answer ${query}`)
    }
    return response.data.result.map((sample) => sample.metric)
  }
}
