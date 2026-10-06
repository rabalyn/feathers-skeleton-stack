import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadDocs } from '../../src/services/docs/docs.js'

// The product's ADRs and diagrams beside the skeleton's on the docs page
// (ADR 0019, 0035). The skeleton holds none but the product's index, so a
// product is made up here: the repository's `docs/adr_v2/` beside a
// `docs/adr_product/` of the test's own.

const SKELETON = new URL('../../../../docs/adr_v2/', import.meta.url)

let root: string

const write = async (path: string, markdown: string) => {
  await mkdir(join(root, path, '..'), { recursive: true })
  await writeFile(join(root, path), markdown)
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'docs-'))
  await cp(SKELETON, join(root, 'adr_v2'), { recursive: true })
  await write('adr_product/README.md', '# Product ADRs\n')
  await write('adr_product/0002-billing.md', '# 0002: Billing\n\n- Status: Proposed\n')
  await write('adr_product/0001-courses.md', '# 0001: Courses\n\n- Status: Accepted\n')
  await write('adr_product/diagrams/README.md', '# Product diagrams\n\n[Enrolment](enrolment.md), [Courses](courses.md)\n')
  await write('adr_product/diagrams/courses.md', '# Course data\n')
  await write('adr_product/diagrams/enrolment.md', '# Enrolment flow\n')
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const at = (path: string) => pathToFileURL(`${path}/`)

describe('loadDocs', () => {
  it("reads the product's pages after the skeleton's, under ids and paths of their own", async () => {
    const docs = await loadDocs(at(root))
    const skeleton = docs.filter((doc) => doc.source === 'skeleton')
    const product = docs.filter((doc) => doc.source === 'product')
    expect(docs.slice(0, skeleton.length)).toEqual(skeleton)
    expect(skeleton[0]).toMatchObject({ id: 'readme', kind: 'index', path: 'adr_v2/README.md' })
    expect(skeleton).toContainEqual(expect.objectContaining({ id: '0001-one-stack-every-environment', path: 'adr_v2/0001-one-stack-every-environment.md' }))
    expect(product.map(({ id, kind, path }) => ({ id, kind, path }))).toEqual([
      { id: 'product-readme', kind: 'index', path: 'adr_product/README.md' },
      { id: 'product-0001-courses', kind: 'adr', path: 'adr_product/0001-courses.md' },
      { id: 'product-0002-billing', kind: 'adr', path: 'adr_product/0002-billing.md' },
      // The diagrams index first, its pages in its order, under its names.
      { id: 'product-diagrams-readme', kind: 'diagram', path: 'adr_product/diagrams/README.md' },
      { id: 'product-diagrams-enrolment', kind: 'diagram', path: 'adr_product/diagrams/enrolment.md' },
      { id: 'product-diagrams-courses', kind: 'diagram', path: 'adr_product/diagrams/courses.md' }
    ])
    expect(product[1]).toMatchObject({ number: '0001', status: 'Accepted' })
    expect(product[5]).toMatchObject({ label: 'Courses', title: 'Course data' })
  })

  it('reads a product without diagrams, or without ADRs at all', async () => {
    await rm(join(root, 'adr_product/diagrams'), { recursive: true })
    expect((await loadDocs(at(root))).filter((doc) => doc.source === 'product').map((doc) => doc.id)).toEqual([
      'product-readme',
      'product-0001-courses',
      'product-0002-billing'
    ])
    await rm(join(root, 'adr_product'), { recursive: true })
    expect((await loadDocs(at(root))).every((doc) => doc.source === 'skeleton')).toBe(true)
  })

  it("requires the skeleton's directory", async () => {
    await rm(join(root, 'adr_v2'), { recursive: true })
    await expect(loadDocs(at(root))).rejects.toThrow()
  })
})
