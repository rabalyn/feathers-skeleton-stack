import type { Knex } from 'knex'
import { irreversible } from '../migration-support.js'

// Editable roles (ADR 0011), expand step: roles are rows composed of
// permission keys from the catalogue in code, and a user holds any number
// of them. users.role is backfilled into user_roles and no longer read; it
// is dropped by the contract step, 20260930000000 (ADR 0003).
//
//   admin    fixed: every permission and role management, none stored
//   seeded   operator and user: stored, editable, not deletable
//   custom   created by an admin; deletable while nobody holds it
//
// A permission is a catalogue key, not a foreign key: the catalogue lives in
// code, and a key it no longer declares grants nothing.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE roles (
      id          uuid        PRIMARY KEY DEFAULT uuidv7(),
      key         text        NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9-]{1,39}$'),
      kind        text        NOT NULL CHECK (kind IN ('admin', 'seeded', 'custom')),
      -- One name per locale (ADR 0027), both required.
      name        jsonb       NOT NULL CHECK (
                                jsonb_typeof(name -> 'de') = 'string' AND length(name ->> 'de') BETWEEN 1 AND 80 AND
                                jsonb_typeof(name -> 'en') = 'string' AND length(name ->> 'en') BETWEEN 1 AND 80
                              ),
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now()
    );
    -- Exactly one admin role.
    CREATE UNIQUE INDEX roles_one_admin_key ON roles (kind) WHERE kind = 'admin';

    CREATE TABLE role_permissions (
      role_id     uuid        NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
      permission  text        NOT NULL CHECK (length(permission) BETWEEN 1 AND 80),
      PRIMARY KEY (role_id, permission)
    );

    -- A held role cannot be deleted (ADR 0011: 409 until it is unassigned).
    CREATE TABLE user_roles (
      user_id     uuid        NOT NULL REFERENCES users (id),
      role_id     uuid        NOT NULL REFERENCES roles (id) ON DELETE RESTRICT,
      PRIMARY KEY (user_id, role_id)
    );
    CREATE INDEX user_roles_role_idx ON user_roles (role_id);

    INSERT INTO roles (key, kind, name) VALUES
      ('admin', 'admin', '{"de": "Administration", "en": "Administration"}'),
      ('operator', 'seeded', '{"de": "Betrieb", "en": "Operations"}'),
      ('user', 'seeded', '{"de": "Benutzer", "en": "User"}');

    -- The permission matrix as it stood, now the seeded defaults (ADR 0011).
    INSERT INTO role_permissions (role_id, permission)
      SELECT roles.id, grants.permission
      FROM roles
      JOIN (VALUES
        ('operator', 'users.read'),
        ('operator', 'directory.read'),
        ('operator', 'documents.all'),
        ('operator', 'sessions.read'),
        ('operator', 'audit-events.read'),
        ('user', 'documents.own')
      ) AS grants (role_key, permission) ON grants.role_key = roles.key;

    INSERT INTO user_roles (user_id, role_id)
      SELECT users.id, roles.id FROM users JOIN roles ON roles.key = users.role;
  `)
}

export const down = irreversible('20260929000400_roles')
