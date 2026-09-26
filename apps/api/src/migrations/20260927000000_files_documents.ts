import type { Knex } from 'knex'
import { irreversible } from '../migration-support.js'

// Uploads (ADR 0020). `files` describes every object in the uploads bucket;
// its id is the object's key. What a user supplies (the filename) is only
// metadata here. Objects are immutable: replacing a file writes a new one.
//
//   pending   the row reserves quota before a byte is stored; the object
//             may be partial or missing
//   stored    the object is complete and verified
//
// A file is attached once something references it (a document, an avatar);
// one never attached is cleaned up by the purge job. Deletion is soft:
// deleted_at is set, and the purge job removes object and row after the
// purge delay, which outlasts backup retention, so a restored database never
// references a purged object (ADR 0017).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE files (
      id            uuid        PRIMARY KEY DEFAULT uuidv7(),
      owner_id      uuid        NOT NULL REFERENCES users (id),
      filename      text        NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
      -- The type verified by magic bytes, never the one merely declared.
      content_type  text        NOT NULL,
      size_bytes    bigint      NOT NULL CHECK (size_bytes > 0),
      sha256        text        CHECK (sha256 ~ '^[0-9a-f]{64}$'),
      state         text        NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'stored')),
      created_at    timestamptz NOT NULL DEFAULT now(),
      attached_at   timestamptz,
      deleted_at    timestamptz,
      CONSTRAINT files_stored_has_checksum CHECK (state = 'pending' OR sha256 IS NOT NULL)
    );
    CREATE INDEX files_owner_idx ON files (owner_id) WHERE deleted_at IS NULL;
    CREATE INDEX files_deleted_idx ON files (deleted_at) WHERE deleted_at IS NOT NULL;
    CREATE INDEX files_unattached_idx ON files (created_at) WHERE attached_at IS NULL AND deleted_at IS NULL;

    CREATE TABLE documents (
      id          uuid        PRIMARY KEY DEFAULT uuidv7(),
      owner_id    uuid        NOT NULL REFERENCES users (id),
      title       text        NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
      file_id     uuid        NOT NULL REFERENCES files (id),
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX documents_owner_idx ON documents (owner_id);
    CREATE UNIQUE INDEX documents_file_key ON documents (file_id);

    ALTER TABLE users ADD COLUMN avatar_file_id uuid REFERENCES files (id);
    CREATE UNIQUE INDEX users_avatar_file_key ON users (avatar_file_id) WHERE avatar_file_id IS NOT NULL;
  `)
}

export const down = irreversible('20260927000000_files_documents')
