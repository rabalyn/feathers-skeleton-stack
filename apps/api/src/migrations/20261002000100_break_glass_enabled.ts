import type { Knex } from 'knex'
import { irreversible } from '../migration-support.js'

// The break-glass account is never disabled (decided 2026-10-02, ADR 0008):
// it is the way in when the IdP fails. The users service refuses the patch;
// this constraint holds it for every other writer, erase_user() included.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    UPDATE users SET enabled = true, updated_at = now() WHERE auth_source = 'local' AND NOT enabled;
    ALTER TABLE users ADD CONSTRAINT users_break_glass_enabled CHECK (auth_source <> 'local' OR enabled);
  `)
}

export const down = irreversible('20261002000100_break_glass_enabled')
