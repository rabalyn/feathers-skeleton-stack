import type { Knex } from 'knex'
import { irreversible } from '../migration-support.js'

// Where a product's erasure goes (ADR 0013, 0035): erase_user_product(),
// which erase_user() calls before it erases the skeleton's tables, in the
// same transaction. The skeleton creates it here as a no-op and never changes
// it again; a product's own migration replaces it (CREATE OR REPLACE, the
// whole function) whenever it adds a table to product/personal-data.ts with
// an erasure rule other than `keep`. erase_user() itself stays the
// skeleton's: a product that redefined it would lose every later skeleton
// change to it, or lose its own in the merge.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE FUNCTION erase_user_product(p_user_id uuid, p_erased_at timestamptz)
    RETURNS void
    LANGUAGE plpgsql
    AS $$
    BEGIN
      -- The skeleton has no product tables.
      NULL;
    END;
    $$;
    REVOKE ALL ON FUNCTION erase_user_product(uuid, timestamptz) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION erase_user_product(uuid, timestamptz) TO app_rw;

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

      -- The product's tables first (ADR 0035): they may reference the
      -- skeleton's rows deleted below.
      PERFORM erase_user_product(p_user_id, p_erased_at);

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

export const down = irreversible('20261006000000_erase_user_product')
