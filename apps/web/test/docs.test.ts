// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { createRenderer, resolveLink, slug } from '@/composables/docs'

const DOCS = [
  { id: 'readme', path: 'adr_v2/README.md' },
  { id: '0019-adr-convention', path: 'adr_v2/0019-adr-convention.md' },
  { id: 'diagrams-readme', path: 'adr_v2/diagrams/README.md' },
  { id: 'diagrams-topology', path: 'adr_v2/diagrams/topology.md' },
  { id: 'product-readme', path: 'adr_product/README.md' },
  { id: 'product-0001-courses', path: 'adr_product/0001-courses.md' },
  { id: 'product-diagrams-enrolment', path: 'adr_product/diagrams/enrolment.md' }
]

describe('resolveLink', () => {
  it('follows relative links between the pages, with their heading', () => {
    expect(resolveLink('adr_v2/README.md', 'diagrams/README.md', DOCS)).toEqual({ doc: 'diagrams-readme', hash: '' })
    expect(resolveLink('adr_v2/diagrams/topology.md', '../0019-adr-convention.md#diagrams', DOCS)).toEqual({
      doc: '0019-adr-convention',
      hash: 'diagrams'
    })
    expect(resolveLink('adr_v2/diagrams/README.md', 'topology.md', DOCS)).toEqual({ doc: 'diagrams-topology', hash: '' })
    expect(resolveLink('adr_v2/README.md', '#index', DOCS)).toEqual({ hash: 'index' })
  })

  it("follows links between the skeleton's pages and the product's (ADR 0035)", () => {
    expect(resolveLink('adr_product/0001-courses.md', '../adr_v2/0019-adr-convention.md#format', DOCS)).toEqual({
      doc: '0019-adr-convention',
      hash: 'format'
    })
    expect(resolveLink('adr_product/diagrams/enrolment.md', '../0001-courses.md', DOCS)).toEqual({ doc: 'product-0001-courses', hash: '' })
    expect(resolveLink('adr_product/README.md', '../../apps/api/src/product/services.ts', DOCS)).toBeNull()
  })

  it('opens the web in a new tab and drops links to the rest of the repository', () => {
    expect(resolveLink('adr_v2/README.md', 'https://mermaid.js.org/', DOCS)).toEqual({ external: 'https://mermaid.js.org/' })
    expect(resolveLink('adr_v2/diagrams/topology.md', '../../../compose.yaml', DOCS)).toBeNull()
    expect(resolveLink('adr_v2/README.md', 'missing.md', DOCS)).toBeNull()
    expect(resolveLink('adr_v2/README.md', '/etc/passwd', DOCS)).toBeNull()
  })
})

describe('slug', () => {
  it('makes GitHub heading anchors', () => {
    expect(slug('Relationship to `docs/adr/`')).toBe('relationship-to-docsadr')
    expect(slug('Not yet decided')).toBe('not-yet-decided')
  })
})

describe('createRenderer', () => {
  const render = createRenderer('adr_v2/README.md', DOCS, (id, hash) => `/docs?page=${id}${hash ? `#${hash}` : ''}`)

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
