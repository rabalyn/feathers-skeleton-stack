import type { RouteMeta } from 'vue-router'

// A link of the navigation drawer (ADR 0014): a route by name, shown when
// the user may open it, on the route's own gate (ADR 0038).
export interface NavLink {
  // The route's name.
  name: string
  // A Material icon name.
  icon: string
  // A message key, e.g. `nav.profile`.
  label: string
}

type Pair = [action: string, subject: string]

// What a gate asks of the session: `can`, whether the user may do this to
// some record of the subject; `canAll`, to every record (ADR 0011).
interface Abilities {
  can: (action: string, subject: string) => boolean
  canAll: (action: string, subject: string) => boolean
}

// A route's gate (ADR 0038): everything `requires` lists, on every record
// of its subject; `requiresSome` on some record; one of `requiresAny`.
export const passesGate = (meta: RouteMeta, session: Abilities): boolean => {
  const all: Pair[] = !meta.requires ? [] : Array.isArray(meta.requires[0]) ? (meta.requires as Pair[]) : [meta.requires as Pair]
  return (
    all.every((pair) => session.canAll(...pair)) &&
    (!meta.requiresSome || session.can(...meta.requiresSome)) &&
    (!meta.requiresAny || meta.requiresAny.some((pair) => session.canAll(...pair)))
  )
}
