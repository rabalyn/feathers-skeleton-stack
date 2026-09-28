import type { Knex } from 'knex'
import { irreversible } from '../migration-support.js'

// The language a person last used in the web app, so mail reaches them in
// it (ADR 0009, 0027). German, the UI's default, until they choose.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE users ADD COLUMN locale text NOT NULL DEFAULT 'de' CHECK (locale IN ('de', 'en'));
  `)
}

export const down = irreversible('20260929000000_user_locale')
