import type { Knex } from 'knex'
import { irreversible } from '../migration-support.js'

// Locations (ADR 0031): reading sites is the catalogue permission
// `sites.read`, so a role can be given or denied it on the permissions page.
// The seeded roles get it, as every signed-in person had it before; a role
// an admin has changed since keeps what it has.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    INSERT INTO role_permissions (role_id, permission)
      SELECT roles.id, 'sites.read' FROM roles WHERE roles.key IN ('operator', 'user')
    ON CONFLICT DO NOTHING;
  `)
}

export const down = irreversible('20260930000200_sites_permission')
