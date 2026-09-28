import type { Knex } from 'knex'
import { irreversible } from '../migration-support.js'

// The mail outbox and delivery log (ADR 0024, 0027): one row per mail to one
// person. A notification's row is written in the transaction of the write
// that causes it; a campaign's rows by the worker when it is sent (its
// foreign key arrives with mail_campaigns). The row holds neither the
// address nor the rendered text: the recipient's surrogate id, the kind,
// its params (surrogate ids or the admin's choices) and, once sent, the
// revision the wording came from.
//
// A skipped delivery says why: the account is disabled, erased, the
// break-glass account or has no email; the kind is no longer declared; or
// its build() found nothing to send.
//
// Erasure deletes the person's deliveries (ADR 0013).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE mail_deliveries (
      id            uuid        PRIMARY KEY DEFAULT uuidv7(),
      user_id       uuid        NOT NULL REFERENCES users (id),
      kind          text        NOT NULL,
      campaign_id   uuid,
      params        jsonb       NOT NULL DEFAULT '{}',
      status        text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
      skip_reason   text        CHECK (skip_reason IN ('disabled', 'erased', 'no-email', 'break-glass', 'unknown-kind', 'nothing-to-send')),
      revision_id   uuid        REFERENCES mail_template_revisions (id),
      attempts      integer     NOT NULL DEFAULT 0,
      error         text,
      created_at    timestamptz NOT NULL DEFAULT now(),
      completed_at  timestamptz,
      CONSTRAINT mail_deliveries_one_per_campaign UNIQUE (campaign_id, user_id),
      CONSTRAINT mail_deliveries_skipped_why CHECK ((status = 'skipped') = (skip_reason IS NOT NULL)),
      CONSTRAINT mail_deliveries_sent_wording CHECK (status <> 'sent' OR (revision_id IS NOT NULL AND completed_at IS NOT NULL))
    );
    CREATE INDEX mail_deliveries_pending_idx ON mail_deliveries (created_at) WHERE status = 'pending';
    CREATE INDEX mail_deliveries_user_idx ON mail_deliveries (user_id);
    CREATE INDEX mail_deliveries_created_at_idx ON mail_deliveries (created_at);

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

export const down = irreversible('20260929000200_mail_deliveries')
