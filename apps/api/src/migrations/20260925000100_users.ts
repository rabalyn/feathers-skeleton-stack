import type { Knex } from 'knex'
import { irreversible } from '../migration-support.js'

// ADR 0009. The surrogate id is what everything else references; the TU-ID
// is the identifier people see. Directory fields are refreshed on every login
// and nullable because erasure clears them (ADR 0013).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE users (
      id          uuid        PRIMARY KEY DEFAULT uuidv7(),
      tu_id       text        UNIQUE,
      given_name  text,
      surname     text,
      email       text,
      role        text        NOT NULL DEFAULT 'user'
                              CHECK (role IN ('admin', 'operator', 'user')),
      enabled     boolean     NOT NULL DEFAULT true,
      auth_source text        NOT NULL CHECK (auth_source IN ('saml', 'local')),
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now(),
      -- The break-glass account has no TU-ID and is told apart by its
      -- authentication source, never by a sentinel value.
      CONSTRAINT users_local_has_no_tu_id CHECK (auth_source = 'saml' OR tu_id IS NULL)
    );
    CREATE UNIQUE INDEX users_email_key ON users (lower(email)) WHERE email IS NOT NULL;
  `)
}

export const down = irreversible('20260925000100_users')
