import type { Knex } from 'knex'
import { irreversible } from '../migration-support.js'

// GDPR export and erasure (ADR 0013).
//
// data_exports: one row per requested export. The object in the `exports`
// bucket has the row's id as its key and exists once the row is `ready`.
// At most one export of a person is pending at a time.
//
// erasures: the log of erased surrogate ids, replayed after a restore
// (ADR 0017). It identifies nobody by itself. No foreign key: a restored
// database may not yet have a user the log names, and replaying the log
// into it must not fail on that.
//
// erase_user() is the erasure itself, in one place, so the api and the
// restore procedure (scripts/backup.sh, psql only) apply the same rules. It
// is idempotent and a no-op for an id no user has. A table added to the
// personal data registry with an erasure rule other than `keep` must be
// handled here (a CREATE OR REPLACE in the migration that adds it); the
// registry test checks that the function names every such table.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE users ADD COLUMN erased_at timestamptz;

    CREATE TABLE data_exports (
      id            uuid        PRIMARY KEY DEFAULT uuidv7(),
      -- The person the export is about.
      subject_id    uuid        NOT NULL REFERENCES users (id),
      -- The account that asked for it, and the only one that may fetch it.
      requested_by  uuid        NOT NULL REFERENCES users (id),
      state         text        NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'ready', 'failed')),
      size_bytes    bigint      CHECK (size_bytes > 0),
      sha256        text        CHECK (sha256 ~ '^[0-9a-f]{64}$'),
      created_at    timestamptz NOT NULL DEFAULT now(),
      completed_at  timestamptz,
      CONSTRAINT data_exports_ready_complete CHECK (
        state <> 'ready' OR (size_bytes IS NOT NULL AND sha256 IS NOT NULL AND completed_at IS NOT NULL)
      )
    );
    CREATE UNIQUE INDEX data_exports_one_pending_key ON data_exports (subject_id) WHERE state = 'pending';
    CREATE INDEX data_exports_requested_by_idx ON data_exports (requested_by);
    CREATE INDEX data_exports_created_at_idx ON data_exports (created_at);

    CREATE TABLE erasures (
      user_id    uuid        PRIMARY KEY,
      erased_at  timestamptz NOT NULL DEFAULT now()
    );

    CREATE FUNCTION erase_user(p_user_id uuid, p_erased_at timestamptz DEFAULT now())
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

      -- Owned documents are deleted; every file of the person, the avatar
      -- included, is soft-deleted and purged on the normal schedule
      -- (ADR 0020).
      DELETE FROM documents WHERE owner_id = p_user_id;
      UPDATE files SET deleted_at = now() WHERE owner_id = p_user_id AND deleted_at IS NULL;

      -- Exports of the person, and exports the person asked for of others.
      -- Their objects are removed by the export expiry job, which removes
      -- objects without a row.
      DELETE FROM data_exports WHERE subject_id = p_user_id OR requested_by = p_user_id;

      -- audit_events and settings reference the surrogate id only and are
      -- kept (ADR 0013): they hold no direct identifier to clear.

      INSERT INTO erasures (user_id, erased_at) VALUES (p_user_id, p_erased_at)
        ON CONFLICT (user_id) DO NOTHING;
      RETURN true;
    END;
    $$;
    REVOKE ALL ON FUNCTION erase_user(uuid, timestamptz) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION erase_user(uuid, timestamptz) TO app_rw;
  `)
}

export const down = irreversible('20260928000000_gdpr')
