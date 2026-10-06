// A link of the navigation drawer (ADR 0014): a route by name, shown when
// the user may open it, by the same rules as the route's meta (ADR 0011).
export interface NavLink {
  // The route's name.
  name: string
  // A Material icon name.
  icon: string
  // A message key, e.g. `nav.profile`.
  label: string
  requires?: [action: string, subject: string]
  requiresSome?: [action: string, subject: string]
  requiresAny?: [action: string, subject: string][]
}
