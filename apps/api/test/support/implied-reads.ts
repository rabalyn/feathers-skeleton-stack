import { grantEntry, type PermissionEntry } from '../../src/abilities.js'

// The reads that catalogue entries imply without conditions or fields
// (ADR 0036), as "<key>: <subject>": what a write opens of its subject in
// full. The skeleton's abilities test lists its own entries with it, a
// product's test its own.
export const unconditionalImpliedReads = (entries: readonly PermissionEntry[]): string[] => {
  const user = { id: 'me', permissions: [] }
  return entries
    .flatMap((entry) => {
      const own: unknown[] = []
      entry.grant(((...args: unknown[]) => own.push(args)) as never, user)
      const all: [string | string[], string | string[], ...unknown[]][] = []
      grantEntry(entry, ((...args: [string | string[], string | string[], ...unknown[]]) => all.push(args)) as never, user)
      // grantEntry passes the entry's own rules first, then what they imply.
      return all
        .slice(own.length)
        .filter(([action, , ...rest]) => action === 'read' && rest.length === 0)
        .map(([, name]) => `${entry.key}: ${[name].flat().join(',')}`)
    })
    .sort()
}
