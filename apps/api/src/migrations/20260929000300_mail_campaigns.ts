import type { Knex } from 'knex'
import { irreversible } from '../migration-support.js'

// Campaigns (ADR 0027): sent by an admin, by hand, never on a schedule. The
// row and its audit event commit together, pinning the active revision of
// each locale, so what is sent is what was previewed even if someone edits
// the template meanwhile. The worker then resolves the recipients into
// mail_deliveries, one per person (unique per campaign and user, so a rerun
// adds no duplicates), and marks the campaign `queued`.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE mail_campaigns (
      id               uuid        PRIMARY KEY DEFAULT uuidv7(),
      kind             text        NOT NULL,
      -- The admin's choices, as the kind's params schema allows.
      params           jsonb       NOT NULL DEFAULT '{}',
      sent_by          uuid        NOT NULL REFERENCES users (id),
      status           text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'queued')),
      recipient_count  integer     CHECK (recipient_count >= 0),
      created_at       timestamptz NOT NULL DEFAULT now(),
      queued_at        timestamptz,
      CONSTRAINT mail_campaigns_queued_complete CHECK (status <> 'queued' OR (recipient_count IS NOT NULL AND queued_at IS NOT NULL))
    );
    CREATE INDEX mail_campaigns_created_at_idx ON mail_campaigns (created_at);
    CREATE INDEX mail_campaigns_sent_by_idx ON mail_campaigns (sent_by);
    CREATE INDEX mail_campaigns_pending_idx ON mail_campaigns (created_at) WHERE status = 'pending';

    CREATE TABLE mail_campaign_revisions (
      campaign_id  uuid NOT NULL REFERENCES mail_campaigns (id),
      locale       text NOT NULL CHECK (locale IN ('de', 'en')),
      revision_id  uuid NOT NULL REFERENCES mail_template_revisions (id),
      PRIMARY KEY (campaign_id, locale)
    );

    ALTER TABLE mail_deliveries
      ADD CONSTRAINT mail_deliveries_campaign_fkey FOREIGN KEY (campaign_id) REFERENCES mail_campaigns (id);
    CREATE INDEX mail_deliveries_campaign_idx ON mail_deliveries (campaign_id, status);
  `)
}

export const down = irreversible('20260929000300_mail_campaigns')
