import type { Knex } from 'knex'
import { irreversible } from '../migration-support.js'

// Read-only view-as (ADR 0028): state of the viewer's own session, not a
// session of the target's. Both columns are set together or not at all.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE auth_sessions
      ADD COLUMN view_as_user_id    uuid REFERENCES users (id),
      ADD COLUMN view_as_expires_at timestamptz,
      ADD CONSTRAINT auth_sessions_view_as_complete CHECK ((view_as_user_id IS NULL) = (view_as_expires_at IS NULL));
  `)
}

export const down = irreversible('20260929000500_view_as')
