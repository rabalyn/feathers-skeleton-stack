import { readFileSync } from 'node:fs'
import { Client, escapeFilter } from 'ldapts'
import type { LdapConfig } from './config.js'

// Directory lookup (ADR 0008): finding a person who has not logged in yet,
// with a read-only service account over LDAPS. Never used to authenticate.
//
// A search term is split into words; every word must be a prefix of the
// TU-ID (cn), given name, surname or mail. Prefix matches use the
// directory's initial-substring indexes even for two-character words
// (historical TU-IDs have two characters), where a "contains" match would
// scan the whole directory. Every word is escaped (ADR 0018).

export const MIN_TERM_LENGTH = 2
export const MAX_TERM_LENGTH = 64
export const MAX_WORDS = 4
// The most entries one search returns; the directory stops there.
export const MAX_RESULTS = 50

const ATTRIBUTES = ['cn', 'givenName', 'sn', 'mail']

export interface DirectoryEntry {
  tuId: string
  givenName: string | null
  surname: string | null
  email: string | null
}

export interface DirectoryResult {
  entries: DirectoryEntry[]
  // The directory had more matches than MAX_RESULTS.
  truncated: boolean
}

export class DirectoryUnavailable extends Error {}

export const searchFilter = (term: string): string => {
  const words = term.trim().split(/\s+/).filter(Boolean).slice(0, MAX_WORDS)
  const clauses = words.map((word) => {
    const escaped = escapeFilter`${word}`
    return `(|${ATTRIBUTES.map((attribute) => `(${attribute}=${escaped}*)`).join('')})`
  })
  return `(&(objectClass=person)${clauses.join('')})`
}

const first = (value: unknown): string | null => {
  const single: unknown = Array.isArray(value) ? (value as unknown[])[0] : value
  if (single === undefined || single === null) return null
  if (typeof single !== 'string' && !Buffer.isBuffer(single)) return null
  const text = Buffer.isBuffer(single) ? single.toString('utf8') : single
  return text.length > 0 ? text : null
}

export class Directory {
  private readonly ca: string

  constructor(private readonly config: LdapConfig) {
    this.ca = readFileSync(config.ldapCaFile, 'utf8')
  }

  // One connection per search: lookups are rare, and nothing stays bound.
  async search(term: string): Promise<DirectoryResult> {
    const client = new Client({
      url: this.config.ldapUrl,
      timeout: 5000,
      connectTimeout: 3000,
      tlsOptions: { ca: this.ca, minVersion: 'TLSv1.2' }
    })
    try {
      await client.bind(this.config.ldapBindDn, this.config.ldapBindPassword)
      const { searchEntries } = await client.search(this.config.ldapBaseDn, {
        scope: 'sub',
        filter: searchFilter(term),
        attributes: ATTRIBUTES,
        // One more than returned, to tell whether there were more.
        sizeLimit: MAX_RESULTS + 1,
        timeLimit: 5
      })
      const entries = searchEntries
        .map((entry) => ({
          tuId: first(entry.cn),
          givenName: first(entry.givenName),
          surname: first(entry.sn),
          email: first(entry.mail)
        }))
        .filter((entry): entry is DirectoryEntry => entry.tuId !== null)
      return { entries: entries.slice(0, MAX_RESULTS), truncated: entries.length > MAX_RESULTS }
    } catch (error) {
      throw new DirectoryUnavailable((error as Error).message)
    } finally {
      await client.unbind().catch(() => undefined)
    }
  }
}
