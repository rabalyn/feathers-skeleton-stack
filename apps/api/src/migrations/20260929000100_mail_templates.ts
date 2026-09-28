import type { Knex } from 'knex'
import { irreversible } from '../migration-support.js'

// Mail templates (ADR 0027): a subject and a Markdown body per mail kind and
// locale. Every save is a new, immutable revision; mail_templates points at
// the active one, and activating an older one rolls back. The migrate job
// seeds each kind's code defaults as revisions by the system (author NULL)
// where a kind and locale has no template yet, and never overwrites one.
//
// `kind` is the key declared in code (mail/registry.ts), not a foreign key:
// a kind removed from code keeps its revisions.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE mail_template_revisions (
      id          uuid        PRIMARY KEY DEFAULT uuidv7(),
      kind        text        NOT NULL,
      locale      text        NOT NULL CHECK (locale IN ('de', 'en')),
      subject     text        NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
      body        text        NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
      -- The admin who saved it; NULL for the code defaults.
      author_id   uuid        REFERENCES users (id),
      created_at  timestamptz NOT NULL DEFAULT now(),
      UNIQUE (id, kind, locale)
    );
    CREATE INDEX mail_template_revisions_kind_idx ON mail_template_revisions (kind, locale, created_at);
    CREATE INDEX mail_template_revisions_author_idx ON mail_template_revisions (author_id);

    CREATE TABLE mail_templates (
      kind         text        NOT NULL,
      locale       text        NOT NULL CHECK (locale IN ('de', 'en')),
      revision_id  uuid        NOT NULL,
      updated_at   timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (kind, locale),
      -- The active revision is one of this kind and locale.
      FOREIGN KEY (revision_id, kind, locale) REFERENCES mail_template_revisions (id, kind, locale)
    );
  `)
}

export const down = irreversible('20260929000100_mail_templates')
