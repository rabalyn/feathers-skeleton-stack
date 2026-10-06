import type { Knex } from 'knex'
import { irreversible } from '../migration-support.js'

// When the person last logged in (ADR 0009), set with every session a login
// opens. Null for an account made from the directory before its first login.
// Existing accounts take their latest login the database still holds: a
// session (view-as excluded, it is nobody's login) or a `login` audit event,
// both kept only for their retention; older logins are gone, and such an
// account shows none until its next one.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE users ADD COLUMN last_login_at timestamptz;
    UPDATE users SET last_login_at = logins.at
      FROM (
        SELECT user_id, max(at) AS at FROM (
          SELECT user_id, issued_at AS at FROM auth_sessions WHERE view_as_expires_at IS NULL
          UNION ALL
          SELECT actor_id, occurred_at FROM audit_events WHERE action = 'login' AND actor_id IS NOT NULL
        ) AS every_login
        GROUP BY user_id
      ) AS logins
      WHERE users.id = logins.user_id;
  `)
}

export const down = irreversible('20261007000000_last_login')
