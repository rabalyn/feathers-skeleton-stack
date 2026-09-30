import type { Knex } from 'knex'
import { irreversible } from '../migration-support.js'

// API tokens (ADR 0029): long-lived credentials for REST calls from scripts,
// owned by the person who created them and bounded by that person's rights
// on every request. The token itself is never stored, only its SHA-256: it
// is 256 random bits, so a slow hash would buy nothing. Revoking deletes the
// row; the audit event remains.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE api_tokens (
      id            uuid        PRIMARY KEY DEFAULT uuidv7(),
      user_id       uuid        NOT NULL REFERENCES users (id),
      name          text        NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
      token_hash    text        NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
      -- The token's last characters, so its owner can tell tokens apart.
      hint          text        NOT NULL CHECK (length(hint) = 4),
      -- Catalogue keys, like role_permissions: a key code no longer declares
      -- grants nothing.
      permissions   text[]      NOT NULL CHECK (cardinality(permissions) >= 1),
      created_at    timestamptz NOT NULL DEFAULT now(),
      -- NULL: until revoked.
      expires_at    timestamptz,
      last_used_at  timestamptz
    );
    CREATE INDEX api_tokens_user_idx ON api_tokens (user_id);

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

export const down = irreversible('20260930000100_api_tokens')
