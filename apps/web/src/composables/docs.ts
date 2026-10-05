import DOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'

// The ADRs and diagram pages as the docs page shows them (ADR 0019): the
// repository's Markdown, rendered in the browser. Raw HTML in the Markdown
// is escaped, not rendered, and the result is sanitized all the same before
// the page shows it (ADR 0018). Links between the pages stay in the app;
// relative links to anything else in the repository lead nowhere here and
// lose their target.

export interface DocRef {
  id: string
  // The file's path below `docs/adr_v2/`.
  path: string
}

export type LinkTarget = { doc: string; hash: string } | { external: string } | { hash: string } | null

// GitHub's heading anchors, which the pages link to: lower case, without
// punctuation, spaces as hyphens.
export const slug = (text: string) =>
  text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')

// Where a link in the page at `from` leads.
export const resolveLink = (from: string, href: string, docs: readonly DocRef[]): LinkTarget => {
  if (/^https?:\/\//i.test(href) || href.startsWith('mailto:')) return { external: href }
  if (href.startsWith('#')) return { hash: href.slice(1) }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/')) return null
  const [file = '', hash = ''] = href.split('#', 2)
  const parts = from.split('/').slice(0, -1)
  for (const part of file.split('/')) {
    if (part === '..') {
      // Above docs/adr_v2/: some other file of the repository.
      if (!parts.length) return null
      parts.pop()
    } else if (part && part !== '.') parts.push(part)
  }
  const path = parts.join('/')
  const doc = docs.find((candidate) => candidate.path === path)
  return doc ? { doc: doc.id, hash } : null
}

export const DOC_LINK_ATTRIBUTE = 'data-doc'
export const DOC_HASH_ATTRIBUTE = 'data-doc-hash'
export const MERMAID_CLASS = 'doc-mermaid'

const escape = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

// A renderer for the page at `from`, whose links resolve against `docs`;
// `hrefOf` gives the app's own address of a page.
export const createRenderer = (from: string, docs: readonly DocRef[], hrefOf: (id: string, hash: string) => string) => {
  const md = new MarkdownIt({ html: false, linkify: false })

  // Mermaid blocks stay text until the page draws them.
  const fence = md.renderer.rules.fence!
  md.renderer.rules.fence = (tokens, index, options, env, self) => {
    const token = tokens[index]!
    if (token.info.trim() === 'mermaid') return `<div class="${MERMAID_CLASS}">${escape(token.content)}</div>\n`
    return fence(tokens, index, options, env, self)
  }

  md.renderer.rules.heading_open = (tokens, index, options, _env, self) => {
    const inline = tokens[index + 1]
    if (inline?.type === 'inline') tokens[index]!.attrSet('id', slug(inline.content))
    return self.renderToken(tokens, index, options)
  }

  md.renderer.rules.link_open = (tokens, index, options, _env, self) => {
    const token = tokens[index]!
    const target = resolveLink(from, String(token.attrGet('href') ?? ''), docs)
    if (!target) {
      token.attrs = (token.attrs ?? []).filter(([name]) => name !== 'href')
      token.attrSet('class', 'doc-link-elsewhere')
    } else if ('external' in target) {
      token.attrSet('target', '_blank')
      token.attrSet('rel', 'noopener noreferrer')
    } else if ('doc' in target) {
      token.attrSet('href', hrefOf(target.doc, target.hash))
      token.attrSet(DOC_LINK_ATTRIBUTE, target.doc)
      token.attrSet(DOC_HASH_ATTRIBUTE, target.hash)
    }
    return self.renderToken(tokens, index, options)
  }

  return (markdown: string) =>
    DOMPurify.sanitize(md.render(markdown), { ADD_ATTR: ['target', DOC_LINK_ATTRIBUTE, DOC_HASH_ATTRIBUTE] })
}
