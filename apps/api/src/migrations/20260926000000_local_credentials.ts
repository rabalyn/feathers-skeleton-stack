import type { Knex } from 'knex'
import { irreversible } from '../migration-support.js'

// The break-glass account's password (ADR 0008), the only password the
// application stores. A table of its own, so nothing that reads users can
// select the hash by accident. At most one local account exists.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE local_credentials (
      user_id        uuid        PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
      -- argon2id in PHC string format.
      password_hash  text        NOT NULL,
      updated_at     timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX users_single_local_key ON users ((true)) WHERE auth_source = 'local';
  `)
}

export const down = irreversible('20260926000000_local_credentials')
