import { access, readdir, readFile } from 'node:fs/promises'
import { NotFound } from '@feathersjs/errors'
import type { Id, Params } from '@feathersjs/feathers'
import { hooks as schemaHooks } from '@feathersjs/schema'
import { Type, type Static } from '@feathersjs/typebox'
import type { Application } from '../../app.js'
import { publishNothing } from '../../channels.js'
import { DOC_SEARCH_MAX_LENGTH } from '../../limits.js'
import { queryValidator, lazyValidator } from '../../validators.js'

// The architecture documentation in the app (ADR 0019): the skeleton's ADRs
// in `docs/adr_v2/`, the product's in `docs/adr_product/` (ADR 0035), and
// the diagram pages beside each, read-only, under `docs.read` (ADR 0011).
// The same Markdown files the repository holds, copied into the api image;
// the browser renders them. They describe the stack's topology, so they are
// served to whoever holds the permission only, never bundled into the
// public web app.

export const DOCS_PATH = 'docs'
export const DOC_EXTERNAL_METHODS = ['find', 'get'] as const

// From src/services/docs/ and dist/services/docs/ alike.
const DOCS_ROOT = new URL('../../../../../docs/', import.meta.url)

export const DOC_KINDS = ['index', 'adr', 'diagram'] as const
export type DocKind = (typeof DOC_KINDS)[number]

// Whose decisions a page holds: the skeleton's, changed upstream only, or
// the product's own.
export const DOC_SOURCES = ['skeleton', 'product'] as const
export type DocSource = (typeof DOC_SOURCES)[number]

// Each source's directory below `docs/` and the prefix of its pages' ids.
// The skeleton's ids carry none, so its pages keep their addresses.
const SOURCES: readonly { source: DocSource; dir: string; prefix: string }[] = [
  { source: 'skeleton', dir: 'adr_v2/', prefix: '' },
  { source: 'product', dir: 'adr_product/', prefix: 'product-' }
]

// What a list shows of a page; `get` adds its Markdown.
export interface DocSummary {
  // `readme`, the ADR's file name (`0001-one-stack-every-environment`), or
  // `diagrams-<page>`; for the product's pages each with `product-` before.
  id: string
  kind: DocKind
  source: DocSource
  // The file's path below `docs/`, which relative links resolve from.
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
    kind: Type.Optional(Type.Union(DOC_KINDS.map((kind) => Type.Literal(kind)))),
    source: Type.Optional(Type.Union(DOC_SOURCES.map((source) => Type.Literal(source))))
  },
  { $id: 'DocQuery', additionalProperties: false }
)
export type DocQuery = Static<typeof docQuerySchema>
export const docQueryValidator = lazyValidator(docQuerySchema, queryValidator)

export type DocParams = Params<DocQuery>

const ADR_FILE = /^(\d{4})-[a-z0-9-]+\.md$/
const PAGE_FILE = /^[a-z0-9-]+\.md$/

const titleOf = (markdown: string, fallback: string) => /^# (.+)$/m.exec(markdown)?.[1]?.trim() ?? fallback
const statusOf = (markdown: string) => /^- Status: (.+)$/m.exec(markdown)?.[1]?.trim() ?? null

const exists = (url: URL) =>
  access(url).then(
    () => true,
    () => false
  )

// The pages the diagrams index links, in its order, with its names for them.
const INDEX_LINK = /\[([^\]]+)\]\(([a-z0-9-]+\.md)\)/g
const indexLinks = (markdown: string) => {
  const links = new Map<string, string>()
  for (const [, label, file] of markdown.matchAll(INDEX_LINK)) if (!links.has(file!)) links.set(file!, label!)
  return links
}

// Every page: the skeleton's, then the product's. Of each, the index, the
// ADRs by number, the diagram pages with their own index first and the
// others as it lists them, any it misses last. The skeleton's directory and
// its diagrams are required; the product's are read where they exist, its
// diagram pages only beside a diagrams index.
export const loadDocs = async (root: URL = DOCS_ROOT): Promise<Doc[]> => {
  const docs: Doc[] = []
  for (const { source, dir, prefix } of SOURCES) {
    const base = new URL(dir, root)
    const required = source === 'skeleton'
    const found = async (path: string) => required || (await exists(new URL(path, base)))
    const page = async (id: string, kind: DocKind, path: string, number: string | null = null, label?: string) => {
      const markdown = await readFile(new URL(path, base), 'utf8')
      const title = titleOf(markdown, id)
      docs.push({
        id: `${prefix}${id}`,
        kind,
        source,
        path: `${dir}${path}`,
        number,
        title,
        label: label ?? title,
        status: kind === 'adr' ? statusOf(markdown) : null,
        markdown
      })
    }
    if (!(await found(''))) continue
    if (await found('README.md')) await page('readme', 'index', 'README.md')
    for (const name of (await readdir(base)).filter((file) => ADR_FILE.test(file)).sort()) {
      await page(name.slice(0, -3), 'adr', name, ADR_FILE.exec(name)![1])
    }
    if (!(await found('diagrams/README.md'))) continue
    const diagrams = (await readdir(new URL('diagrams/', base))).filter((file) => file !== 'README.md' && PAGE_FILE.test(file))
    const linked = indexLinks(await readFile(new URL('diagrams/README.md', base), 'utf8'))
    const order = [...linked.keys()]
    const rank = (name: string) => (order.includes(name) ? order.indexOf(name) : order.length)
    await page('diagrams-readme', 'diagram', 'diagrams/README.md')
    for (const name of diagrams.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))) {
      await page(`diagrams-${name.slice(0, -3)}`, 'diagram', `diagrams/${name}`, null, linked.get(name))
    }
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
    const { q, kind, source } = params?.query ?? {}
    const words = [...new Set((q ?? '').toLowerCase().split(/\s+/).filter(Boolean))]
    const docs = (await this.all()).filter((doc) => (!kind || doc.kind === kind) && (!source || doc.source === source))
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
