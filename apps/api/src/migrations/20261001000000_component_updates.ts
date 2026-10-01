import type { Knex } from 'knex'
import { irreversible } from '../migration-support.js'

// The daily update check's results (ADR 0032), one row per component, so the
// system-info page and the worker's metrics read the same state and a worker
// restart loses nothing. A failed check keeps the last results and records
// why; `checked_at` is the last success.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE component_updates (
      component       text        PRIMARY KEY CHECK (component ~ '^[a-z0-9-]+$'),
      -- The version the check compared against: the declared tag, or the
      -- host's reported OS version.
      compared        text,
      latest_patch    text,
      latest_minor    text,
      latest_major    text,
      -- When the check first saw each of the above; kept while it stays the
      -- same, so "a patch has waited 7 days" survives later checks.
      patch_since     timestamptz,
      minor_since     timestamptz,
      major_since     timestamptz,
      -- The running line's end of life. eol_line set and eol NULL: the line
      -- is known, no date is announced. Both NULL: no source knows it.
      eol_line        text,
      eol             date,
      checked_at      timestamptz,
      attempted_at    timestamptz NOT NULL,
      error           text,
      -- Since when the check has failed without a success in between; the
      -- alert reads it, so a check that never succeeded alerts as well.
      failing_since   timestamptz
    );
  `)
}

export const down = irreversible('20261001000000_component_updates')
