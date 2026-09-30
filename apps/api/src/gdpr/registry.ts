import type { Knex } from 'knex'
import type { PRODUCTION_BUCKETS } from '../storage.js'

// The personal data registry (ADR 0013): every store that holds personal
// data, how it contributes to a person's export and what erasure does to it.
// A table that references users(id) must be listed here, which
// test/integration/gdpr-registry.test.ts checks against the live schema; a
// product adds its own tables here, and extends the export, never shrinks it.
//
// Erasure itself is the database function erase_user() (migration
// 20260928000000_gdpr), so the api and a restore apply the same rules; the
// rule named here documents it, and the test checks that the function names
// every table whose rule is not `keep`.

export type ErasureRule =
  // Direct identifiers are cleared; the row and its surrogate key stay.
  | 'clear-identifiers'
  | 'delete'
  // Marked deleted, removed later by the purge job (ADR 0020).
  | 'soft-delete'
  // Kept: the rows reference the surrogate id only.
  | 'keep'

export interface TableEntry {
  kind: 'table'
  // The table's name in the database.
  table: string
  // Its columns that reference users(id).
  userColumns: readonly string[]
  // The key of the export this table fills, and the rows (camelCase Knex)
  // it contributes; absent for a table whose contents are not information
  // about the person, with the reason in `note`.
  export?: { key: string; collect: (knex: Knex, userId: string) => Promise<unknown> }
  erasure: ErasureRule
  note: string
}

export interface BucketEntry {
  kind: 'bucket'
  bucket: (typeof PRODUCTION_BUCKETS)[number]
  // Whether the export carries the objects themselves.
  exported: boolean
  erasure: ErasureRule
  note: string
}

export type RegistryEntry = TableEntry | BucketEntry

// Files an export carries: the person's stored, not deleted uploads.
export const exportedFiles = (knex: Knex, userId: string) =>
  knex('files')
    .where({ ownerId: userId, state: 'stored' })
    .whereNull('deletedAt')
    .orderBy('createdAt')
    .select('id', 'filename', 'contentType', 'sizeBytes', 'sha256', 'createdAt', 'attachedAt')

export const PERSONAL_DATA: readonly RegistryEntry[] = [
  {
    kind: 'table',
    table: 'users',
    userColumns: [],
    export: {
      key: 'account',
      collect: (knex, userId) =>
        knex('users')
          .where({ id: userId })
          .first(
            'id',
            'tuId',
            'givenName',
            'surname',
            'email',
            'enabled',
            'authSource',
            'locale',
            'avatarFileId',
            'createdAt',
            'updatedAt'
          )
    },
    erasure: 'clear-identifiers',
    note: 'The person: TU-ID, name, surname, email and avatar are cleared, the account disabled'
  },
  {
    kind: 'table',
    table: 'user_roles',
    userColumns: ['user_id'],
    export: {
      key: 'roles',
      collect: (knex, userId) =>
        knex('userRoles')
          .join('roles', 'roles.id', 'userRoles.roleId')
          .where('userRoles.userId', userId)
          .orderBy('roles.key')
          .select('roles.key', 'roles.name')
    },
    erasure: 'keep',
    note: 'The roles the person holds (ADR 0011); they identify nobody, and the erased account is disabled'
  },
  {
    kind: 'table',
    table: 'auth_sessions',
    // view_as_user_id: whom the session viewed as (ADR 0028), which the
    // target learns from the audit events about their account.
    userColumns: ['user_id', 'view_as_user_id'],
    export: {
      key: 'sessions',
      collect: (knex, userId) =>
        knex('authSessions')
          .where({ userId })
          .orderBy('issuedAt')
          .select(
            'id',
            'issuedAt',
            'lastUsedAt',
            'idleExpiresAt',
            'familyExpiresAt',
            'revokedAt',
            'userAgent',
            'samlNameId',
            'samlNameIdFormat',
            'viewAsUserId',
            'viewAsExpiresAt'
          )
    },
    erasure: 'delete',
    note: 'Logins, with user agent and the IdP name id; token hashes are security material and not exported'
  },
  {
    kind: 'table',
    table: 'auth_refresh_tokens',
    userColumns: [],
    erasure: 'delete',
    note: 'Refresh token hashes of a session; security material, not information about the person'
  },
  {
    kind: 'table',
    table: 'api_tokens',
    userColumns: ['user_id'],
    export: {
      key: 'apiTokens',
      collect: (knex, userId) =>
        knex('apiTokens')
          .where({ userId })
          .orderBy('createdAt')
          .select('id', 'name', 'permissions', 'createdAt', 'expiresAt', 'lastUsedAt')
    },
    erasure: 'delete',
    note: 'The person\'s API tokens (ADR 0029): name, permissions, use; the token hash is security material and not exported'
  },
  {
    kind: 'table',
    table: 'local_credentials',
    userColumns: ['user_id'],
    erasure: 'keep',
    note: 'The break-glass password hash; that account holds no personal data and cannot be erased'
  },
  {
    kind: 'table',
    table: 'settings',
    userColumns: ['updated_by'],
    export: {
      key: 'settingsChanged',
      collect: (knex, userId) =>
        knex('settings').where({ updatedBy: userId }).orderBy('key').select('key', 'updatedAt')
    },
    erasure: 'keep',
    note: 'Who last changed a runtime setting, by surrogate id'
  },
  {
    kind: 'table',
    table: 'audit_events',
    userColumns: ['actor_id'],
    export: {
      key: 'auditEvents',
      // What the person did, what was done to their account, and who
      // exported their data.
      collect: (knex, userId) =>
        knex('auditEvents')
          .where({ actorId: userId })
          .orWhere({ resourceType: 'users', resourceId: userId })
          .orWhereRaw(`detail->>'subjectId' = ?`, [userId])
          .orderBy('occurredAt')
          .select('id', 'occurredAt', 'actorId', 'action', 'resourceType', 'resourceId', 'requestId', 'detail')
    },
    erasure: 'keep',
    note: 'Surrogate ids only, never direct identifiers (ADR 0013), so erasure leaves them pseudonymous'
  },
  {
    kind: 'table',
    table: 'files',
    userColumns: ['owner_id'],
    export: { key: 'files', collect: exportedFiles },
    erasure: 'soft-delete',
    note: 'Metadata of every upload; the bytes are in the uploads bucket'
  },
  {
    kind: 'table',
    table: 'documents',
    userColumns: ['owner_id'],
    export: {
      key: 'documents',
      collect: (knex, userId) =>
        knex('documents').where({ ownerId: userId }).orderBy('createdAt').select('id', 'title', 'fileId', 'createdAt', 'updatedAt')
    },
    erasure: 'delete',
    note: 'Documents owned by the person'
  },
  {
    kind: 'table',
    table: 'data_exports',
    userColumns: ['subject_id', 'requested_by'],
    export: {
      key: 'dataExports',
      collect: (knex, userId) =>
        knex('dataExports')
          .where({ subjectId: userId })
          .orderBy('createdAt')
          .select('id', 'requestedBy', 'state', 'createdAt', 'completedAt')
    },
    erasure: 'delete',
    note: 'Exports of the person, and exports the person asked for'
  },
  {
    kind: 'table',
    table: 'mail_template_revisions',
    userColumns: ['author_id'],
    export: {
      key: 'mailTemplateRevisions',
      collect: (knex, userId) =>
        knex('mailTemplateRevisions').where({ authorId: userId }).orderBy('createdAt').select('id', 'kind', 'locale', 'createdAt')
    },
    erasure: 'keep',
    note: 'Mail wording an admin saved (ADR 0027), by surrogate id; the wording itself is not about the person'
  },
  {
    kind: 'table',
    table: 'mail_campaigns',
    userColumns: ['sent_by'],
    export: {
      key: 'mailCampaignsSent',
      collect: (knex, userId) =>
        knex('mailCampaigns').where({ sentBy: userId }).orderBy('createdAt').select('id', 'kind', 'params', 'recipientCount', 'createdAt')
    },
    erasure: 'keep',
    note: 'Campaigns an admin sent (ADR 0027), by surrogate id, like audit events'
  },
  {
    kind: 'table',
    table: 'mail_deliveries',
    userColumns: ['user_id'],
    export: {
      key: 'mailDeliveries',
      collect: (knex, userId) =>
        knex('mailDeliveries')
          .where({ userId })
          .orderBy('createdAt')
          .select('id', 'kind', 'campaignId', 'params', 'status', 'skipReason', 'revisionId', 'attempts', 'error', 'createdAt', 'completedAt')
    },
    erasure: 'delete',
    note: 'The mail sent to the person (ADR 0027): kind, wording revision, outcome; neither address nor text'
  },
  {
    kind: 'table',
    table: 'erasures',
    userColumns: [],
    erasure: 'keep',
    note: 'The log of erased surrogate ids, replayed after a restore (ADR 0017); identifies nobody by itself'
  },
  {
    kind: 'bucket',
    bucket: 'uploads',
    exported: true,
    erasure: 'soft-delete',
    note: 'Objects of the files table: exported under files/<id>/<filename>, purged after erasure with their rows'
  },
  {
    kind: 'bucket',
    bucket: 'exports',
    exported: false,
    erasure: 'delete',
    note: 'Generated exports; removed with their data_exports row, and after the export retention'
  }
]

export const TABLE_ENTRIES = PERSONAL_DATA.filter((entry): entry is TableEntry => entry.kind === 'table')
export const BUCKET_ENTRIES = PERSONAL_DATA.filter((entry): entry is BucketEntry => entry.kind === 'bucket')
