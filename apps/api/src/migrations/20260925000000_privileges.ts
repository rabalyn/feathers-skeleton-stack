import type { Knex } from 'knex'
import { irreversible } from '../migration-support.js'

// Everything the migrator creates is usable, not alterable, by app_rw, the
// group role of the application and test logins (containers/postgres/initdb).
// Set here rather than at database creation so the application database and
// test_template (ADR 0015) are configured by the same code.
//
// `public` belongs to pg_database_owner by default, which in a per-worker
// clone would be the test role, letting tests do DDL the application cannot.
// Owning it explicitly keeps test privileges equal to production.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER SCHEMA public OWNER TO migrator;
    REVOKE ALL ON SCHEMA public FROM PUBLIC;
    GRANT USAGE ON SCHEMA public TO app_rw;
    ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
    ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO app_rw;
  `)
}

export const down = irreversible('20260925000000_privileges')
