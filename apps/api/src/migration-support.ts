// ADR 0003: rollback rolls back code, not schema. Knex insists on a `down`
// for every migration, so each one exports this, which refuses loudly
// instead of dropping data.
export const irreversible = (name: string) => async (): Promise<never> => {
  throw new Error(
    `${name} is not reversible: schema changes are rolled forward (expand and contract, ADR 0003)`
  )
}
