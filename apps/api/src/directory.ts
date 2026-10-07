import { readFileSync } from 'node:fs'
import type { Knex } from 'knex'
import { Client, escapeFilter } from 'ldapts'
import type { LdapConfig } from './config.js'
import { DIRECTORY_MAX_RESULTS as MAX_RESULTS } from './limits.js'

// Directory lookup (ADR 0008): finding a person who has not logged in yet,
// and the directory fields of an account made before the first login (ADR 0009),
// with a read-only service account over LDAPS. Never used to authenticate.
//
// A search term is split into words; every word must be a prefix of the
// TU-ID (cn), given name, surname or mail. Prefix matches use the
// directory's initial-substring indexes even for two-character words
// (historical TU-IDs have two characters), where a "contains" match would
// scan the whole directory. Every word is escaped (ADR 0018).

export {
  DIRECTORY_MAX_RESULTS as MAX_RESULTS,
  DIRECTORY_PAGE_MAX as PAGE_MAX,
  DIRECTORY_MAX_TERM_LENGTH as MAX_TERM_LENGTH,
  DIRECTORY_MIN_TERM_LENGTH as MIN_TERM_LENGTH
} from './limits.js'
export const MAX_WORDS = 4

const ATTRIBUTES = ['cn', 'givenName', 'sn', 'mail']

export interface DirectoryEntry {
  tuId: string
  givenName: string | null
  surname: string | null
  email: string | null
}

export interface DirectoryResult {
  entries: DirectoryEntry[]
  // The search reached MAX_RESULTS, the directory's size limit, so there
  // may be more matches than it returned.
  truncated: boolean
}

export class DirectoryUnavailable extends Error {}

// Further attributes a product reads about a person (ADR 0008), each with all
// its values as text, in the product's spelling of its name; an attribute the
// person lacks has none.
export type DirectoryValues = Record<string, string[]>

export interface DirectoryPerson extends DirectoryEntry {
  values: DirectoryValues
}

// What a product reads from the directory beyond the account's own fields
// (ADR 0008, 0009), declared in product/directory.ts. `apply` gets their
// values where accountFor() makes an account and at every login the
// directory answers, in a transaction of its own there; it keeps what it
// derives in the product's own tables, registered as personal data
// (ADR 0013), and must give the same result when called twice.
export interface ProductDirectory {
  attributes: readonly string[]
  apply: (trx: Knex | Knex.Transaction, userId: string, values: DirectoryValues) => Promise<void>
}

const ATTRIBUTE_NAME = /^[A-Za-z][A-Za-z0-9-]*$/
const RESERVED = new Set([...ATTRIBUTES, 'userPassword'].map((name) => name.toLowerCase()))

// Refused at start (ADR 0035): a name that is no attribute description, one
// of the account's own, the password, or a name given twice (LDAP names
// ignore case).
export const checkProductDirectory = ({ attributes }: ProductDirectory): void => {
  const seen = new Set<string>()
  for (const name of attributes) {
    const key = name.toLowerCase()
    if (!ATTRIBUTE_NAME.test(name)) throw new Error(`product directory attribute "${name}" is no attribute name`)
    if (RESERVED.has(key)) throw new Error(`product directory attribute "${name}" is the skeleton's`)
    if (seen.has(key)) throw new Error(`product directory attribute "${name}" is named twice`)
    seen.add(key)
  }
}

export const searchFilter = (term: string): string => {
  const words = term.trim().split(/\s+/).filter(Boolean).slice(0, MAX_WORDS)
  const clauses = words.map((word) => {
    const escaped = escapeFilter`${word}`
    return `(|${ATTRIBUTES.map((attribute) => `(${attribute}=${escaped}*)`).join('')})`
  })
  return `(&(objectClass=person)${clauses.join('')})`
}

// One person by exact TU-ID, for making their account (ADR 0009).
export const tuIdFilter = (tuId: string): string => `(&(objectClass=person)(cn=${escapeFilter`${tuId}`}))`

// Pages are cut from one sorted list, so a page turn neither repeats nor
// skips anybody: the directory itself returns entries in no stated order.
const collator = new Intl.Collator('de', { sensitivity: 'base' })
const byName = (a: DirectoryEntry, b: DirectoryEntry) =>
  collator.compare(a.surname ?? '', b.surname ?? '') ||
  collator.compare(a.givenName ?? '', b.givenName ?? '') ||
  collator.compare(a.tuId, b.tuId)

const first = (value: unknown): string | null => {
  const single: unknown = Array.isArray(value) ? (value as unknown[])[0] : value
  if (single === undefined || single === null) return null
  if (typeof single !== 'string' && !Buffer.isBuffer(single)) return null
  const text = Buffer.isBuffer(single) ? single.toString('utf8') : single
  return text.length > 0 ? text : null
}

const all = (value: unknown): string[] =>
  (Array.isArray(value) ? (value as unknown[]) : [value])
    .map((single) => (Buffer.isBuffer(single) ? single.toString('utf8') : single))
    .filter((single): single is string => typeof single === 'string' && single.length > 0)

// The server names an attribute in its own spelling, which may differ from
// the product's in case.
const valuesOf = (entry: Record<string, unknown>, attributes: readonly string[]): DirectoryValues => {
  const byKey = new Map(Object.entries(entry).map(([name, value]) => [name.toLowerCase(), value]))
  return Object.fromEntries(attributes.map((name) => [name, all(byKey.get(name.toLowerCase()))]))
}

export class Directory {
  private readonly ca: string

  constructor(private readonly config: LdapConfig) {
    this.ca = readFileSync(config.ldapCaFile, 'utf8')
  }

  // One connection per search: lookups are rare, and nothing stays bound.
  async search(term: string): Promise<DirectoryResult> {
    const found = await this.query({
      filter: searchFilter(term),
      // Never more than the directory's own limit allows. A search that
      // reaches it may have had more matches: the server answers
      // sizeLimitExceeded, which ldapts returns as a result when a
      // sizeLimit was asked for, but without telling it from exactly
      // MAX_RESULTS matches.
      sizeLimit: MAX_RESULTS
    })
    // A search reads the account's fields only.
    const entries = found.entries.map(({ values: _values, ...entry }): DirectoryEntry => entry)
    return { entries: entries.sort(byName), truncated: found.count >= MAX_RESULTS }
  }

  // The person with this TU-ID, or null when the directory does not know it,
  // with the values of the further attributes asked for.
  async find(tuId: string, attributes: readonly string[] = []): Promise<DirectoryPerson | null> {
    const { entries } = await this.query({ filter: tuIdFilter(tuId), sizeLimit: 2, attributes })
    return entries.find((entry) => entry.tuId === tuId) ?? null
  }

  private async query({
    filter,
    sizeLimit,
    attributes = []
  }: {
    filter: string
    sizeLimit: number
    attributes?: readonly string[]
  }) {
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
        filter,
        attributes: [...ATTRIBUTES, ...attributes],
        sizeLimit,
        timeLimit: 5
      })
      const entries = searchEntries
        .map((entry) => ({
          tuId: first(entry.cn),
          givenName: first(entry.givenName),
          surname: first(entry.sn),
          email: first(entry.mail),
          values: valuesOf(entry, attributes)
        }))
        .filter((entry): entry is DirectoryPerson => entry.tuId !== null)
      return { entries, count: searchEntries.length }
    } catch (error) {
      throw new DirectoryUnavailable((error as Error).message)
    } finally {
      await client.unbind().catch(() => undefined)
    }
  }
}
