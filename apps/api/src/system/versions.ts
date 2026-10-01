// Comparing image tags as versions (ADR 0032). A tag is a version when it is
// numeric parts with an optional `v`, then an optional suffix
// (`18.6-alpine`, `v1.92.0`, `24.21.0-trixie-slim`). A candidate counts only
// with the same `v`, the same number of parts and the same suffix as the
// running tag, so floating tags (`18`, `latest`), other variants
// (`18.6-bookworm`) and pre-releases (`3.8.0-rc1`) never count.
//
// A suffix that is itself a version, as in NetBox's `v4.7.2-5.1.1` (the
// upstream version, then the image's revision), is compared after the
// version when the component says so (`revision`).

export interface TagRule {
  // How many leading parts name a release line: 1 for PostgreSQL's `18`,
  // 2 for Valkey's `9.1`. A newer version in the line is a patch.
  lineDepth: number
  // The suffix is the image's own numeric revision.
  revision?: boolean
}

export interface Version {
  tag: string
  v: boolean
  parts: number[]
  suffix: string
  revision: number[]
}

export interface Updates {
  // Newest within the running line.
  patch: string | null
  // Newest within the running major, in a later line (lineDepth > 1).
  minor: string | null
  // Newest in a later major.
  major: string | null
}

const TAG = /^(v?)(\d+(?:\.\d+)+|\d+)((?:[-+][\w.-]+)?)$/
const REVISION = /^-(\d+(?:\.\d+)*)$/

export const parseTag = (tag: string, rule: Pick<TagRule, 'revision'> = {}): Version | null => {
  const match = TAG.exec(tag)
  if (!match) return null
  const [, v, numbers, suffix] = match
  const parts = numbers!.split('.').map(Number)
  if (rule.revision) {
    const revision = REVISION.exec(suffix!)
    if (!revision) return null
    return { tag, v: v === 'v', parts, suffix: '', revision: revision[1]!.split('.').map(Number) }
  }
  return { tag, v: v === 'v', parts, suffix: suffix!, revision: [] }
}

const compareParts = (a: number[], b: number[]): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? -1) - (b[i] ?? -1)
    if (diff) return diff
  }
  return 0
}

export const compareVersions = (a: Version, b: Version): number =>
  compareParts(a.parts, b.parts) || compareParts(a.revision, b.revision)

// Same shape as the running tag: comparable at all.
const sameShape = (a: Version, b: Version, rule: TagRule) =>
  a.v === b.v &&
  a.parts.length === b.parts.length &&
  a.suffix === b.suffix &&
  (!rule.revision || a.revision.length === b.revision.length)

const samePrefix = (a: Version, b: Version, depth: number) => a.parts.slice(0, depth).every((part, i) => part === b.parts[i])

// The release line of a version, as endoflife.date names it (`18`, `9.1`).
export const lineOf = (version: Version, rule: TagRule) => version.parts.slice(0, rule.lineDepth).join('.')

export const findUpdates = (running: string, tags: Iterable<string>, rule: TagRule): Updates => {
  const current = parseTag(running, rule)
  if (!current) throw new Error(`not a version tag: ${running}`)
  let patch: Version | null = null
  let minor: Version | null = null
  let major: Version | null = null
  const newest = (best: Version | null, candidate: Version) =>
    !best || compareVersions(candidate, best) > 0 ? candidate : best
  for (const tag of tags) {
    const candidate = parseTag(tag, rule)
    if (!candidate || !sameShape(candidate, current, rule) || compareVersions(candidate, current) <= 0) continue
    if (samePrefix(candidate, current, rule.lineDepth)) patch = newest(patch, candidate)
    else if (samePrefix(candidate, current, 1)) minor = newest(minor, candidate)
    else major = newest(major, candidate)
  }
  return { patch: patch?.tag ?? null, minor: minor?.tag ?? null, major: major?.tag ?? null }
}
