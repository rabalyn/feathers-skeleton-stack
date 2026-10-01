// Items in a person's own order (decided 2026-10-02, ADR 0014), kept apart
// from the store so they test without one.

// The links in the stored order. A link the order does not name, one the
// person gained since, keeps its default place: right after the link that
// precedes it by default, or first. Names of links not shown are skipped.
export const arrange = <T extends { name: string }>(links: readonly T[], order: readonly string[] | null): T[] => {
  if (!order?.length) return [...links]
  const byName = new Map(links.map((link) => [link.name, link]))
  const result = order.flatMap((name) => byName.get(name) ?? [])
  links.forEach((link, index) => {
    if (result.includes(link)) return
    const before = index > 0 ? result.indexOf(links[index - 1]!) : -1
    result.splice(before + 1, 0, link)
  })
  return result
}

// The order after moving the link at `from` to `to`, both indices of
// `names`.
export const moved = (names: readonly string[], from: number, to: number): string[] => {
  const result = [...names]
  const [name] = result.splice(from, 1)
  if (name === undefined || to < 0 || to > result.length) return [...names]
  result.splice(to, 0, name)
  return result
}
