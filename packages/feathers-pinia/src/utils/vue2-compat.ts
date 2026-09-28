// Vue 2 reactivity helpers, which vue-demi used to re-export. Vue 3 tracks
// plain assignment and `delete`, so both are ordinary property operations.
// The loose signatures are Vue 2's own, which the call sites were written for.
export function set<T>(target: any, key: PropertyKey, value: T): T {
  target[key] = value
  return value
}

export function del(target: any, key: PropertyKey): void {
  delete target[key]
}
