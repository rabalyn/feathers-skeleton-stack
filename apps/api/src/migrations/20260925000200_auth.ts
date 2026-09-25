import type { Knex } from 'knex'
import { irreversible } from '../migration-support.js'

// ADR 0008 (SAML request state, replay cache) and ADR 0010 (sessions).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    -- One row per login session. The refresh token itself is never stored,
    -- only its SHA-256; tokens are 256 random bits, so a plain hash suffices.
    CREATE TABLE auth_sessions (
      id                  uuid        PRIMARY KEY DEFAULT uuidv7(),
      user_id             uuid        NOT NULL REFERENCES users (id),
      family_id           uuid        NOT NULL DEFAULT uuidv7(),
      refresh_token_hash  bytea       NOT NULL UNIQUE,
      issued_at           timestamptz NOT NULL DEFAULT now(),
      last_used_at        timestamptz NOT NULL DEFAULT now(),
      idle_expires_at     timestamptz NOT NULL,
      family_expires_at   timestamptz NOT NULL,
      rotated_at          timestamptz,
      revoked_at          timestamptz,
      user_agent          text,
      -- The IdP session this login belongs to, for SP-initiated logout.
      saml_name_id        text,
      saml_name_id_format text,
      saml_session_index  text,
      CHECK (idle_expires_at <= family_expires_at)
    );
    CREATE INDEX auth_sessions_user_id_idx ON auth_sessions (user_id);
    CREATE INDEX auth_sessions_family_id_idx ON auth_sessions (family_id);

    -- Authentication requests this SP issued and has not yet seen answered.
    -- Consumed atomically by the ACS (DELETE ... RETURNING).
    CREATE TABLE saml_requests (
      id          text        PRIMARY KEY,
      return_to   text        NOT NULL DEFAULT '/',
      created_at  timestamptz NOT NULL DEFAULT now(),
      expires_at  timestamptz NOT NULL
    );
    CREATE INDEX saml_requests_expires_at_idx ON saml_requests (expires_at);

    -- Replay cache: an assertion ID is accepted once.
    CREATE TABLE saml_assertions (
      id          text        PRIMARY KEY,
      consumed_at timestamptz NOT NULL DEFAULT now(),
      expires_at  timestamptz NOT NULL
    );
    CREATE INDEX saml_assertions_expires_at_idx ON saml_assertions (expires_at);
  `)
}

export const down = irreversible('20260925000200_auth')
