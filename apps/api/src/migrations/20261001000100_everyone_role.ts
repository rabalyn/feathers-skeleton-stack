import type { Knex } from 'knex'
import { irreversible } from '../migration-support.js'

// The `everyone` role (ADR 0011, decided 2026-10-01): held by every signed-in
// account without an assignment, editable on the permissions page, neither
// deletable nor assignable. It is seeded with what the baseline gave every
// account beyond the fixed core, now catalogue permissions, so nobody loses
// anything until an admin changes it.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE roles DROP CONSTRAINT roles_kind_check;
    ALTER TABLE roles ADD CONSTRAINT roles_kind_check CHECK (kind IN ('admin', 'everyone', 'seeded', 'custom'));
    -- Exactly one everyone role, like admin.
    CREATE UNIQUE INDEX roles_one_everyone_key ON roles (kind) WHERE kind = 'everyone';

    INSERT INTO roles (key, kind, name) VALUES
      ('everyone', 'everyone', '{"de": "Alle Angemeldeten", "en": "Everyone signed in"}');

    INSERT INTO role_permissions (role_id, permission)
      SELECT roles.id, grants.permission
      FROM roles
      CROSS JOIN (VALUES
        ('profile.avatar'),
        ('profile.locale'),
        ('files.upload'),
        ('files.own'),
        ('audit-events.own'),
        ('roles.own-names'),
        ('api-tokens.own')
      ) AS grants (permission)
      WHERE roles.kind = 'everyone';
  `)
}

export const down = irreversible('20261001000100_everyone_role')
