import { request } from 'node:https'

// HTTPS GET for the system-info sources (ADR 0032): Prometheus inside the
// stack, verified against the CA root, and the update check's hosts on the
// internet, verified against the system roots. node:https follows no
// redirect; every request has a timeout and a cap on the response size, and
// a response is only ever parsed as data.

export class SourceError extends Error {}

export interface GetOptions {
  // A PEM CA root instead of the system roots.
  ca?: string
  headers?: Record<string, string>
  timeoutMs?: number
  maxBytes?: number
}

export interface Response {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024

export const getText = (url: URL, options: GetOptions = {}): Promise<Response> =>
  new Promise<Response>((resolve, reject) => {
    if (url.protocol !== 'https:') return reject(new SourceError(`not https: ${url.origin}`))
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    const req = request(
      url,
      {
        method: 'GET',
        ...(options.ca ? { ca: options.ca } : {}),
        minVersion: 'TLSv1.2',
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        headers: { Accept: 'application/json', ...options.headers }
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > maxBytes) return req.destroy(new SourceError(`${url.host}: response larger than ${maxBytes} bytes`))
          chunks.push(chunk)
        })
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
        )
        res.on('error', (error) => reject(error instanceof SourceError ? error : new SourceError(`${url.host}: ${error.message}`)))
      }
    )
    req.on('timeout', () => req.destroy(new SourceError(`${url.host}: timeout`)))
    req.on('error', (error) => reject(error instanceof SourceError ? error : new SourceError(`${url.host}: ${error.message}`)))
    req.end()
  })

export const getJson = async <T>(url: URL, options: GetOptions = {}): Promise<T> => {
  const response = await getText(url, options)
  if (response.status !== 200) throw new SourceError(`${url.host} answered ${response.status}`)
  try {
    return JSON.parse(response.body) as T
  } catch {
    throw new SourceError(`${url.host} sent no JSON`)
  }
}
