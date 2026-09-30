import type { Knex } from 'knex'
import { irreversible } from '../migration-support.js'

// Contract step of editable roles (ADR 0003, 0011). Since 20260929000400 a
// user's roles are rows of user_roles, and nothing reads or writes this
// column; its CHECK constraint goes with it.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE users DROP COLUMN role;
  `)
}

export const down = irreversible('20260930000000_drop_users_role')
