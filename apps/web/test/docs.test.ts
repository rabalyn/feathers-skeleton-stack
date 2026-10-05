// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { createRenderer, resolveLink, slug } from '@/composables/docs'

const DOCS = [
  { id: 'readme', path: 'README.md' },
  { id: '0019-adr-convention', path: '0019-adr-convention.md' },
  { id: 'diagrams-readme', path: 'diagrams/README.md' },
  { id: 'diagrams-topology', path: 'diagrams/topology.md' }
]

describe('resolveLink', () => {
  it('follows relative links between the pages, with their heading', () => {
    expect(resolveLink('README.md', 'diagrams/README.md', DOCS)).toEqual({ doc: 'diagrams-readme', hash: '' })
    expect(resolveLink('diagrams/topology.md', '../0019-adr-convention.md#diagrams', DOCS)).toEqual({
      doc: '0019-adr-convention',
      hash: 'diagrams'
    })
    expect(resolveLink('diagrams/README.md', 'topology.md', DOCS)).toEqual({ doc: 'diagrams-topology', hash: '' })
    expect(resolveLink('README.md', '#index', DOCS)).toEqual({ hash: 'index' })
  })

  it('opens the web in a new tab and drops links to the rest of the repository', () => {
    expect(resolveLink('README.md', 'https://mermaid.js.org/', DOCS)).toEqual({ external: 'https://mermaid.js.org/' })
    expect(resolveLink('diagrams/topology.md', '../../../compose.yaml', DOCS)).toBeNull()
    expect(resolveLink('README.md', 'missing.md', DOCS)).toBeNull()
    expect(resolveLink('README.md', '/etc/passwd', DOCS)).toBeNull()
  })
})

describe('slug', () => {
  it('makes GitHub heading anchors', () => {
    expect(slug('Relationship to `docs/adr/`')).toBe('relationship-to-docsadr')
    expect(slug('Not yet decided')).toBe('not-yet-decided')
  })
})

describe('createRenderer', () => {
  const render = createRenderer('README.md', DOCS, (id, hash) => `/docs?page=${id}${hash ? `#${hash}` : ''}`)

  it('rewrites links between pages to the app and keeps diagrams as text', () => {
    const html = render('[0019](0019-adr-convention.md#diagrams)\n\n```mermaid\nflowchart LR\n  a-->b\n```\n')
    expect(html).toContain('href="/docs?page=0019-adr-convention#diagrams"')
    expect(html).toContain('data-doc="0019-adr-convention"')
    expect(html).toContain('<div class="doc-mermaid">flowchart LR\n  a--&gt;b\n</div>')
  })

  it('renders no markup from the Markdown itself (ADR 0018)', () => {
    const html = render('<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('href="javascript')
  })
})
