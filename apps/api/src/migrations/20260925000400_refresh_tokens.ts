import type { Knex } from 'knex'
import { irreversible } from '../migration-support.js'

// ADR 0010: refresh token rotation. An auth_sessions row is one login (one
// token family) and keeps its id, which the access token names, across
// rotations; each refresh token of the family is a row here. Rotated rows
// are kept until the family expires, because deleting them is what would
// silently disable reuse detection.
//
// Expand step (ADR 0003): auth_sessions.refresh_token_hash, rotated_at and
// family_id are no longer written or read, and are dropped in a later
// release.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE auth_refresh_tokens (
      id          uuid        PRIMARY KEY DEFAULT uuidv7(),
      session_id  uuid        NOT NULL REFERENCES auth_sessions (id),
      token_hash  bytea       NOT NULL UNIQUE,
      issued_at   timestamptz NOT NULL DEFAULT now(),
      rotated_at  timestamptz
    );
    -- At most one current token per family.
    CREATE UNIQUE INDEX auth_refresh_tokens_current_key
      ON auth_refresh_tokens (session_id) WHERE rotated_at IS NULL;

    INSERT INTO auth_refresh_tokens (session_id, token_hash, issued_at)
      SELECT id, refresh_token_hash, issued_at FROM auth_sessions;

    ALTER TABLE auth_sessions ALTER COLUMN refresh_token_hash DROP NOT NULL;
  `)
}

export const down = irreversible('20260925000400_refresh_tokens')
