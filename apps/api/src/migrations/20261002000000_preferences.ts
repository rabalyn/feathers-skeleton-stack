import type { Knex } from 'knex'
import { irreversible } from '../migration-support.js'

// A person's own preferences (decided 2026-10-02, ADR 0014), served by the
// `preferences` service: one row per person and key, the value checked
// against the key's schema in preferences/registry.ts. Granted to everyone
// through the `everyone` role (ADR 0011), and deleted on erasure (ADR 0013).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE preferences (
      id          uuid        PRIMARY KEY DEFAULT uuidv7(),
      user_id     uuid        NOT NULL REFERENCES users (id),
      key         text        NOT NULL CHECK (key ~ '^[a-zA-Z][a-zA-Z0-9]*$' AND length(key) <= 64),
      value       jsonb       NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, key)
    );

    INSERT INTO role_permissions (role_id, permission)
      SELECT id, 'profile.preferences' FROM roles WHERE kind = 'everyone';

    CREATE OR REPLACE FUNCTION erase_user(p_user_id uuid, p_erased_at timestamptz DEFAULT now())
    RETURNS boolean
    LANGUAGE plpgsql
    AS $$
    BEGIN
      -- Direct identifiers go; the surrogate key and what references it stay.
      UPDATE users
         SET tu_id = NULL, given_name = NULL, surname = NULL, email = NULL,
             avatar_file_id = NULL, enabled = false,
             erased_at = COALESCE(erased_at, p_erased_at), updated_at = now()
       WHERE id = p_user_id;
      IF NOT FOUND THEN
        RETURN false;
      END IF;

      -- Sessions carry a user agent and the IdP's name for the person.
      DELETE FROM auth_refresh_tokens
       WHERE session_id IN (SELECT id FROM auth_sessions WHERE user_id = p_user_id);
      DELETE FROM auth_sessions WHERE user_id = p_user_id;

      -- The person's API tokens (ADR 0029).
      DELETE FROM api_tokens WHERE user_id = p_user_id;

      -- The person's preferences (decided 2026-10-02).
      DELETE FROM preferences WHERE user_id = p_user_id;

      -- Owned documents are deleted; every file of the person, the avatar
      -- included, is soft-deleted and purged on the normal schedule
      -- (ADR 0020).
      DELETE FROM documents WHERE owner_id = p_user_id;
      UPDATE files SET deleted_at = now() WHERE owner_id = p_user_id AND deleted_at IS NULL;

      -- Exports of the person, and exports the person asked for of others.
      -- Their objects are removed by the export expiry job, which removes
      -- objects without a row.
      DELETE FROM data_exports WHERE subject_id = p_user_id OR requested_by = p_user_id;

      -- The mail delivery log (ADR 0027): who got which mail.
      DELETE FROM mail_deliveries WHERE user_id = p_user_id;

      -- audit_events and settings reference the surrogate id only and are
      -- kept (ADR 0013): they hold no direct identifier to clear.

      INSERT INTO erasures (user_id, erased_at) VALUES (p_user_id, p_erased_at)
        ON CONFLICT (user_id) DO NOTHING;
      RETURN true;
    END;
    $$;
  `)
}

export const down = irreversible('20261002000000_preferences')
