import type { Knex } from 'knex'
import { irreversible } from '../migration-support.js'

// Locations (ADR 0031): reading a site's rooms is `locations.read`, given to
// the seeded roles that read sites, as rooms are looked up by the same
// people. Adding one (`locations.create`) is granted by an admin or a
// product; a role an admin has changed since keeps what it has.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    INSERT INTO role_permissions (role_id, permission)
      SELECT roles.id, 'locations.read' FROM roles WHERE roles.key IN ('operator', 'user')
    ON CONFLICT DO NOTHING;
  `)
}

export const down = irreversible('20261009000000_locations_permission')
