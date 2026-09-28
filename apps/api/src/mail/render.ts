import { Liquid, type FilterImplOptions, type Template } from 'liquidjs'
import MarkdownIt, { type Token } from 'markdown-it'
import type { Locale } from '../locales.js'
import { layout } from './layout.js'

// Rendering a mail (ADR 0027): Liquid, then Markdown, then the MJML layout
// in code. Admins write the subject and the Markdown body; they never touch
// the HTML frame, reach anything but the variables given, or output a value
// as markup.

export class TemplateError extends Error {
  constructor(
    message: string,
    // 1-based, where LiquidJS or the link check can say.
    readonly line?: number
  ) {
    super(message)
  }
}

// The fixed filter set (ADR 0027): the locale's dates and numbers, and a
// few of LiquidJS's built-ins. Anything else fails under strictFilters.
export const BUILTIN_FILTERS = [
  'default',
  'upcase',
  'downcase',
  'capitalize',
  'size',
  'first',
  'last',
  'join',
  'plus',
  'minus',
  'round'
] as const

// Mail is read in the university's time zone, wherever the worker runs.
const TIME_ZONE = 'Europe/Berlin'

const toDate = (value: unknown, filter: string): Date => {
  const date = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(date.getTime())) throw new Error(`${filter}: not a date: ${String(value)}`)
  return date
}

const localeFilters = (locale: Locale): Record<string, FilterImplOptions> => {
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: TIME_ZONE })
  const datetime = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeStyle: 'short', timeZone: TIME_ZONE })
  const number = new Intl.NumberFormat(locale)
  return {
    date: (value: unknown) => date.format(toDate(value, 'date')),
    datetime: (value: unknown) => datetime.format(toDate(value, 'datetime')),
    number: (value: unknown) => {
      const n = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(n)) throw new Error(`number: not a number: ${String(value)}`)
      return number.format(n)
    }
  }
}

// Every value a body outputs is escaped for Markdown: each ASCII punctuation
// character gets a backslash, which CommonMark turns back into the character
// as text, and a line break becomes a space, so a value never starts a
// heading, a list or a new paragraph. A name containing `[x](https://…)` or
// `<img>` is shown as written. Raw HTML is off in Markdown as well.
// What an output prints: a list or an object as LiquidJS would print it.
const text = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.map(text).join('')
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value.toString()
  return JSON.stringify(value)
}

export const escapeMarkdown = (value: unknown): string =>
  text(value)
    .replace(/[\r\n]+/g, ' ')
    .replace(/[!-/:-@[-`{-~]/g, (c) => `\\${c}`)

// Subjects are plain text: nothing to escape, but one line.
const oneLine = (value: unknown): string => text(value).replace(/[\r\n]+/g, ' ')

const liquid = (locale: Locale, outputEscape: (value: unknown) => string) => {
  const engine = new Liquid({
    strictVariables: true,
    strictFilters: true,
    ownPropertyOnly: true,
    outputEscape,
    // No partials: a template sees nothing but its own text.
    relativeReference: false,
    root: [],
    fs: {
      exists: async () => false,
      existsSync: () => false,
      readFile: async () => Promise.reject(new Error('templates cannot include files')),
      readFileSync: () => {
        throw new Error('templates cannot include files')
      },
      resolve: () => {
        throw new Error('templates cannot include files')
      }
    },
    // Bounds on what a template may cost (characters, milliseconds, and
    // roughly the number of items created).
    parseLimit: 50_000,
    renderLimit: 1_000,
    memoryLimit: 1_000_000
  })
  for (const tag of ['include', 'render', 'layout', 'block']) delete engine.tags[tag]
  const allowed = new Set<string>(BUILTIN_FILTERS)
  for (const name of Object.keys(engine.filters)) if (!allowed.has(name)) delete engine.filters[name]
  for (const [name, filter] of Object.entries(localeFilters(locale))) engine.registerFilter(name, filter)
  return engine
}

const engines = new Map<Locale, { body: Liquid; subject: Liquid }>()
const enginesFor = (locale: Locale) => {
  let pair = engines.get(locale)
  if (!pair) {
    pair = { body: liquid(locale, escapeMarkdown), subject: liquid(locale, oneLine) }
    engines.set(locale, pair)
  }
  return pair
}

// LiquidJS reports `line:N, col:M` in its messages.
const lineOf = (error: unknown): number | undefined => {
  const match = /line:(\d+)/.exec((error as Error).message)
  return match ? Number(match[1]) : undefined
}

const wrap = (part: string, error: unknown): TemplateError =>
  error instanceof TemplateError
    ? error
    : new TemplateError(`${part}: ${(error as Error).message.split('\n')[0]}`, lineOf(error))

export const parseTemplate = (locale: Locale, part: 'subject' | 'body', text: string): Template[] => {
  try {
    return enginesFor(locale)[part].parse(text)
  } catch (error) {
    throw wrap(part, error)
  }
}

// Every path a template reads from its variables, with where it is read:
// `recipient.givenName`, `documents` (loop variables are the loop's own).
export const templateVariablePaths = (locale: Locale, part: 'subject' | 'body', text: string) => {
  const templates = parseTemplate(locale, part, text)
  const analysis = enginesFor(locale)[part].analyzeSync(templates, { partials: false })
  return Object.values(analysis.globals).flatMap((variables) =>
    variables.map((variable) => ({ segments: variable.toArray(), line: variable.location.row }))
  )
}

// Markdown without raw HTML, images or automatic links; a link must point
// into the application.
const markdown = new MarkdownIt('commonmark', { html: false, linkify: false, typographer: false }).disable(['image'])

// Lines are those of the rendered Markdown, which match the template's
// unless Liquid added or removed some before the link.
const checkLinks = (tokens: Token[], appUrl: string, line?: number) => {
  const origin = new URL(appUrl).origin
  for (const token of tokens) {
    if (token.children) checkLinks(token.children, appUrl, token.map ? token.map[0] + 1 : line)
    if (token.type !== 'link_open') continue
    const href = String(token.attrGet('href') ?? '')
    let target: URL | undefined
    try {
      target = new URL(href)
    } catch {
      target = undefined
    }
    if (!target || target.origin !== origin || target.username || target.password) {
      throw new TemplateError(`body: links must point into the application (${origin}), not ${href}`, line)
    }
  }
}

// The same Markdown as plain text: paragraphs apart, list items with a dash,
// a link as its text and its address.
const toText = (tokens: Token[]): string => {
  let out = ''
  let listDepth = 0
  const ordered: number[] = []
  const inline = (children: Token[]): string => {
    let text = ''
    const hrefs: string[] = []
    for (const child of children) {
      switch (child.type) {
        case 'text':
        case 'code_inline':
          text += child.content
          break
        case 'softbreak':
        case 'hardbreak':
          text += '\n'
          break
        case 'link_open':
          hrefs.push(String(child.attrGet('href') ?? ''))
          break
        case 'link_close':
          text += ` (${hrefs.pop() ?? ''})`
          break
      }
    }
    return text
  }
  for (const token of tokens) {
    switch (token.type) {
      case 'bullet_list_open':
        listDepth++
        ordered.push(0)
        break
      case 'ordered_list_open':
        listDepth++
        ordered.push(Number(token.attrGet('start') ?? 1))
        break
      case 'bullet_list_close':
      case 'ordered_list_close':
        listDepth--
        ordered.pop()
        if (listDepth === 0) out += '\n'
        break
      case 'list_item_open': {
        const index = ordered.length - 1
        const marker = ordered[index] ? `${ordered[index]++}. ` : '- '
        out += `${'  '.repeat(listDepth - 1)}${marker}`
        break
      }
      case 'inline':
        out += inline(token.children ?? [])
        break
      case 'paragraph_close':
        out += listDepth > 0 ? '\n' : '\n\n'
        break
      case 'heading_close':
        out += '\n\n'
        break
      case 'code_block':
      case 'fence':
        out += `${token.content}\n`
        break
      case 'hr':
        out += '----\n\n'
        break
    }
  }
  return out.replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

export interface RenderInput {
  locale: Locale
  subject: string
  body: string
  // The template variables, `recipient` and `app` included.
  variables: Record<string, unknown> & { app: { name: string; url: string } }
}

export interface RenderedMail {
  subject: string
  html: string
  text: string
}

export const renderMail = async ({ locale, subject, body, variables }: RenderInput): Promise<RenderedMail> => {
  const { subject: subjectEngine, body: bodyEngine } = enginesFor(locale)
  let renderedSubject: string
  let renderedBody: string
  try {
    renderedSubject = oneLine(await subjectEngine.render(parseTemplate(locale, 'subject', subject), variables)).trim()
  } catch (error) {
    throw wrap('subject', error)
  }
  try {
    renderedBody = text(await bodyEngine.render(parseTemplate(locale, 'body', body), variables))
  } catch (error) {
    throw wrap('body', error)
  }
  if (!renderedSubject) throw new TemplateError('subject: empty')
  const tokens = markdown.parse(renderedBody, {})
  checkLinks(tokens, variables.app.url)
  const content = markdown.renderer.render(tokens, markdown.options, {})
  return {
    subject: renderedSubject,
    html: await layout(locale, { subject: renderedSubject, content, app: variables.app }),
    text: `${toText(tokens)}\n-- \n${variables.app.name}: ${variables.app.url}\n`
  }
}
