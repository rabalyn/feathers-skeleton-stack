import type { Knex } from 'knex'
import { irreversible } from '../migration-support.js'

// Contract step of refresh token rotation (ADR 0003, 0010). Since
// 20260925000400 the tokens live in auth_refresh_tokens and nothing reads or
// writes these columns; their unique constraint and index go with them.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE auth_sessions
      DROP COLUMN refresh_token_hash,
      DROP COLUMN rotated_at,
      DROP COLUMN family_id;
  `)
}

export const down = irreversible('20260925000500_drop_session_token_columns')
