import type { Knex } from 'knex'
import { irreversible } from '../migration-support.js'

// ADR 0025 (runtime settings) and ADR 0013 (audit events). Rows of `settings`
// are seeded from the registry by the migrate job after the migrations, not
// here, so a later release adds its keys without a migration of its own.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE settings (
      key         text        PRIMARY KEY,
      value       jsonb       NOT NULL,
      updated_at  timestamptz NOT NULL DEFAULT now(),
      -- Null for the seeded default.
      updated_by  uuid        REFERENCES users (id)
    );

    -- What was done, by which account, to which resource; never request
    -- bodies, credentials or assertion contents (ADR 0013). Rows reference
    -- the surrogate id, so erasure leaves them pseudonymous.
    CREATE TABLE audit_events (
      id             uuid        PRIMARY KEY DEFAULT uuidv7(),
      occurred_at    timestamptz NOT NULL DEFAULT now(),
      actor_id       uuid        REFERENCES users (id),
      action         text        NOT NULL,
      resource_type  text        NOT NULL,
      resource_id    text,
      request_id     text,
      detail         jsonb       NOT NULL DEFAULT '{}'
    );
    CREATE INDEX audit_events_occurred_at_idx ON audit_events (occurred_at);
    CREATE INDEX audit_events_actor_id_idx ON audit_events (actor_id);
  `)
}

export const down = irreversible('20260925000300_settings_audit')
