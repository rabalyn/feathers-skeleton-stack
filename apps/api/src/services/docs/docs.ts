import { readdir, readFile } from 'node:fs/promises'
import { NotFound } from '@feathersjs/errors'
import type { Id, Params } from '@feathersjs/feathers'
import { hooks as schemaHooks } from '@feathersjs/schema'
import { Type, getValidator, type Static } from '@feathersjs/typebox'
import type { Application } from '../../app.js'
import { publishNothing } from '../../channels.js'
import { DOC_SEARCH_MAX_LENGTH } from '../../limits.js'
import { queryValidator } from '../../validators.js'

// The architecture documentation in the app (ADR 0019): the ADRs of
// `docs/adr_v2/` and the diagram pages beside them, read-only, under
// `docs.read` (ADR 0011). The same Markdown files the repository holds,
// copied into the api image; the browser renders them. They describe the
// stack's topology, so they are served to whoever holds the permission only,
// never bundled into the public web app.

export const DOCS_PATH = 'docs'
export const DOC_EXTERNAL_METHODS = ['find', 'get'] as const

// From src/services/docs/ and dist/services/docs/ alike.
const DOCS_DIR = new URL('../../../../../docs/adr_v2/', import.meta.url)

export const DOC_KINDS = ['index', 'adr', 'diagram'] as const
export type DocKind = (typeof DOC_KINDS)[number]

// What a list shows of a page; `get` adds its Markdown.
export interface DocSummary {
  // `readme`, the ADR's file name (`0001-one-stack-every-environment`), or
  // `diagrams-<page>`.
  id: string
  kind: DocKind
  // The file's path below `docs/adr_v2/`, which relative links resolve from.
  path: string
  // The ADR's number, e.g. `0001`.
  number: string | null
  title: string
  // A short name: a diagram page's as the diagrams index links it, the
  // title otherwise.
  label: string
  // The ADR's `Status` line.
  status: string | null
  // With a search: the line of the first match.
  excerpt?: string
}

export interface Doc extends DocSummary {
  markdown: string
}

export const docQuerySchema = Type.Object(
  {
    // Words that must all occur in the page, in any case.
    q: Type.Optional(Type.String({ maxLength: DOC_SEARCH_MAX_LENGTH })),
    kind: Type.Optional(Type.Union(DOC_KINDS.map((kind) => Type.Literal(kind))))
  },
  { $id: 'DocQuery', additionalProperties: false }
)
export type DocQuery = Static<typeof docQuerySchema>
export const docQueryValidator = getValidator(docQuerySchema, queryValidator)

export type DocParams = Params<DocQuery>

const ADR_FILE = /^(\d{4})-[a-z0-9-]+\.md$/
const PAGE_FILE = /^[a-z0-9-]+\.md$/

const titleOf = (markdown: string, fallback: string) => /^# (.+)$/m.exec(markdown)?.[1]?.trim() ?? fallback
const statusOf = (markdown: string) => /^- Status: (.+)$/m.exec(markdown)?.[1]?.trim() ?? null

const read = async (path: string) => readFile(new URL(path, DOCS_DIR), 'utf8')

// The pages the diagrams index links, in its order, with its names for them.
const INDEX_LINK = /\[([^\]]+)\]\(([a-z0-9-]+\.md)\)/g
const indexLinks = (markdown: string) => {
  const links = new Map<string, string>()
  for (const [, label, file] of markdown.matchAll(INDEX_LINK)) if (!links.has(file!)) links.set(file!, label!)
  return links
}

// Every page: the index, the ADRs by number, the diagram pages with their
// own index first and the others as it lists them, any it misses last.
export const loadDocs = async (): Promise<Doc[]> => {
  const docs: Doc[] = []
  const page = async (id: string, kind: DocKind, path: string, number: string | null = null, label?: string) => {
    const markdown = await read(path)
    const title = titleOf(markdown, id)
    docs.push({ id, kind, path, number, title, label: label ?? title, status: kind === 'adr' ? statusOf(markdown) : null, markdown })
  }
  await page('readme', 'index', 'README.md')
  for (const name of (await readdir(DOCS_DIR)).filter((file) => ADR_FILE.test(file)).sort()) {
    await page(name.slice(0, -3), 'adr', name, ADR_FILE.exec(name)![1])
  }
  const diagrams = (await readdir(new URL('diagrams/', DOCS_DIR))).filter((file) => file !== 'README.md' && PAGE_FILE.test(file))
  const linked = indexLinks(await read('diagrams/README.md'))
  const order = [...linked.keys()]
  const rank = (name: string) => (order.includes(name) ? order.indexOf(name) : order.length)
  await page('diagrams-readme', 'diagram', 'diagrams/README.md')
  for (const name of diagrams.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))) {
    await page(`diagrams-${name.slice(0, -3)}`, 'diagram', `diagrams/${name}`, null, linked.get(name))
  }
  return docs
}

const summary = ({ markdown: _markdown, ...rest }: Doc): DocSummary => rest

// What a search reads of a page: its text as a reader sees it, without
// link targets, emphasis or the heading marks, one line per line.
const plainLines = (markdown: string) =>
  markdown
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/[*_`[\]]/g, '')
    .replace(/^#+\s*/gm, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

const occurrences = (text: string, word: string) => text.split(word).length - 1

// The line holding most of the words, trimmed around the first of them.
const EXCERPT_LENGTH = 160
const excerptOf = (lines: string[], words: string[]) => {
  const score = (line: string) => words.filter((word) => line.toLowerCase().includes(word)).length
  const line = lines.reduce((best, candidate) => (score(candidate) > score(best) ? candidate : best), '')
  const lower = line.toLowerCase()
  const first = Math.min(...words.map((word) => lower.indexOf(word)).filter((index) => index >= 0))
  const at = Math.max(0, first - EXCERPT_LENGTH / 4)
  const cut = line.slice(at, at + EXCERPT_LENGTH).trim()
  return `${at > 0 ? '…' : ''}${cut}${at + EXCERPT_LENGTH < line.length ? '…' : ''}`
}

export class DocService {
  // Read once: the files change only with the image.
  private docs?: Promise<Doc[]>

  // Pages holding every word, in any case: those with the words in their
  // title first, then by how often the words occur, then in page order.
  async find(params?: DocParams): Promise<DocSummary[]> {
    const { q, kind } = params?.query ?? {}
    const words = [...new Set((q ?? '').toLowerCase().split(/\s+/).filter(Boolean))]
    const docs = (await this.all()).filter((doc) => !kind || doc.kind === kind)
    if (!words.length) return docs.map(summary)
    return docs
      .map((doc, order) => {
        const lines = plainLines(doc.markdown)
        const text = lines.join('\n').toLowerCase()
        const title = doc.title.toLowerCase()
        return {
          doc,
          order,
          lines,
          found: words.every((word) => text.includes(word)),
          inTitle: words.filter((word) => title.includes(word)).length,
          count: words.reduce((sum, word) => sum + occurrences(text, word), 0)
        }
      })
      .filter((hit) => hit.found)
      .sort((a, b) => b.inTitle - a.inTitle || b.count - a.count || a.order - b.order)
      .map((hit) => ({ ...summary(hit.doc), excerpt: excerptOf(hit.lines, words) }))
  }

  async get(id: Id, _params?: DocParams): Promise<Doc> {
    const doc = (await this.all()).find((candidate) => candidate.id === String(id))
    if (!doc) throw new NotFound('No such page')
    return doc
  }

  private all() {
    this.docs ??= loadDocs().catch((error: unknown) => {
      this.docs = undefined
      throw error
    })
    return this.docs
  }
}

export const docs = (app: Application) => {
  app.use(DOCS_PATH, new DocService(), { methods: [...DOC_EXTERNAL_METHODS] })
  app.service(DOCS_PATH).hooks({
    before: { find: [schemaHooks.validateQuery(docQueryValidator)] }
  })
  // Read only.
  app.service(DOCS_PATH).publish(publishNothing)
}

declare module '../../app.js' {
  interface ServiceTypes {
    [DOCS_PATH]: DocService
  }
}
