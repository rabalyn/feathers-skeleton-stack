// Browser-safe client entry point (ADR 0007). At runtime it may reach only
// the modules the dependency boundary allowlists (.dependency-cruiser.cjs):
// never Knex, pg, the SAML library, resolvers or hooks. Server types are
// imported with `import type`, which leaves nothing at runtime.
import { feathers, type Application, type ClientService, type Paginated, type Params, type TransportConnection } from '@feathersjs/feathers'
import authenticationClient, { MemoryStorage, type AuthenticationClientOptions } from '@feathersjs/authentication-client'
import type { DirectoryEntry, DirectoryPage, DirectoryQuery } from './services/directory/directory.schema.js'
import type { DIRECTORY_EXTERNAL_METHODS } from './services/directory/directory.js'
import type { Setting, SettingPatch, SettingQuery } from './services/settings/settings.schema.js'
import type { SETTING_EXTERNAL_METHODS } from './services/settings/settings.js'
import type { User, UserPatch, UserQuery } from './services/users/users.schema.js'
import type { USER_EXTERNAL_METHODS } from './services/users/users.js'
import type { AvatarData, AVATAR_EXTERNAL_METHODS } from './services/users/avatars.js'
import type { LocaleData, LOCALE_EXTERNAL_METHODS } from './services/users/locales.js'
import type { Document, DocumentData, DocumentPatch, DocumentQuery } from './services/documents/documents.schema.js'
import type { DOCUMENT_EXTERNAL_METHODS } from './services/documents/documents.js'
import type { File, FileQuery } from './services/files/files.schema.js'
import type { DataExport, DataExportData, DataExportQuery } from './services/data-exports/data-exports.schema.js'
import type { DATA_EXPORT_EXTERNAL_METHODS } from './services/data-exports/data-exports.js'
import type { Erasure, ErasureData, ERASURE_EXTERNAL_METHODS } from './services/erasures/erasures.js'
import type { AuditEvent, AuditEventQuery, AUDIT_EVENT_EXTERNAL_METHODS } from './services/audit-events/audit-events.js'
import type { Session, SessionQuery, SESSION_EXTERNAL_METHODS } from './services/sessions/sessions.js'
import type {
  MailDelivery,
  MailDeliveryQuery,
  MailCampaign,
  MailCampaignData,
  MailCampaignPreview,
  MailCampaignPreviewData,
  MailCampaignQuery,
  MailKindInfo,
  MailPreview,
  MailPreviewData,
  MailTemplate,
  MailTemplatePatch,
  MailTemplateQuery,
  MailTemplateRevision,
  MailTemplateRevisionData,
  MailTemplateRevisionQuery
} from './services/mail/mail.schema.js'
import type {
  MAIL_KIND_EXTERNAL_METHODS,
  MAIL_PREVIEW_EXTERNAL_METHODS,
  MAIL_TEMPLATE_EXTERNAL_METHODS,
  MAIL_TEMPLATE_REVISION_EXTERNAL_METHODS
} from './services/mail/mail-templates.js'
import type { MAIL_CAMPAIGN_EXTERNAL_METHODS, MAIL_CAMPAIGN_PREVIEW_EXTERNAL_METHODS } from './services/mail/mail-campaigns.js'
import type { MAIL_DELIVERY_EXTERNAL_METHODS } from './services/mail/mail-deliveries.js'
import type { QueueStatus } from './services/queues/queues.schema.js'
import type { QUEUE_EXTERNAL_METHODS } from './services/queues/queues.js'

export type { User, UserPatch, UserQuery } from './services/users/users.schema.js'
export type { Setting, SettingPatch, SettingQuery } from './services/settings/settings.schema.js'
export type { DirectoryEntry, DirectoryPage, DirectoryQuery } from './services/directory/directory.schema.js'
export type { Document, DocumentData, DocumentPatch, DocumentQuery } from './services/documents/documents.schema.js'
export type { File } from './services/files/files.schema.js'
export type { AvatarData } from './services/users/avatars.js'
export type { LocaleData } from './services/users/locales.js'
export { DEFAULT_LOCALE, LOCALES, type Locale } from './locales.js'
export type { DataExport, DataExportData, DataExportQuery } from './services/data-exports/data-exports.schema.js'
export type { Erasure, ErasureData } from './services/erasures/erasures.js'
export type { AuditEvent, AuditEventQuery } from './services/audit-events/audit-events.js'
export type { Session, SessionQuery } from './services/sessions/sessions.js'
export type {
  MailDelivery,
  MailDeliveryQuery,
  MailCampaign,
  MailCampaignData,
  MailCampaignPreview,
  MailCampaignPreviewData,
  MailCampaignQuery,
  MailKindInfo,
  MailPreview,
  MailPreviewData,
  MailTemplate,
  MailTemplatePatch,
  MailTemplateQuery,
  MailTemplateRevision,
  MailTemplateRevisionData,
  MailTemplateRevisionQuery
} from './services/mail/mail.schema.js'
export type { QueueJob, QueueJobState, QueueScheduler, QueueStatus } from './services/queues/queues.schema.js'
export { ALLOWED_CONTENT_TYPES, AVATAR_CONTENT_TYPES, FILENAME_HEADER, type AllowedContentType } from './uploads.js'
export { ROLES, defineAbilitiesFor, type AbilityUser, type AppAbility, type Role } from './abilities.js'
// For asking an ability about one record, as the server does.
export { subject } from '@casl/ability'
export { PAGINATE } from './paginate.js'
export {
  API_PREFIX,
  AUTHENTICATION_URL,
  DATA_EXPORT_CONTENTS_URL,
  FILE_CONTENTS_URL,
  FILES_URL,
  SAML_LOGIN_URL,
  SOCKET_PATH
} from './paths.js'
export { DIRECTORY_MAX_RESULTS, DIRECTORY_MAX_TERM_LENGTH, DIRECTORY_MIN_TERM_LENGTH } from './limits.js'

type External<S, M extends readonly (keyof S)[]> = Pick<S, M[number]>

// The services as a browser sees them: only their external methods, with
// the shapes the schemas give them.
export interface ClientServiceTypes {
  users: External<ClientService<User, never, UserPatch, Paginated<User>, Params<UserQuery>>, typeof USER_EXTERNAL_METHODS>
  settings: External<
    ClientService<Setting, never, SettingPatch, Paginated<Setting>, Params<SettingQuery>>,
    typeof SETTING_EXTERNAL_METHODS
  >
  directory: External<
    ClientService<DirectoryEntry, never, never, DirectoryPage, Params<DirectoryQuery>>,
    typeof DIRECTORY_EXTERNAL_METHODS
  >
  documents: External<
    ClientService<Document, DocumentData, DocumentPatch, Paginated<Document>, Params<DocumentQuery>>,
    typeof DOCUMENT_EXTERNAL_METHODS
  >
  // The caller's own avatar; the result is their user record.
  avatars: External<ClientService<User, AvatarData, never, never, Params>, typeof AVATAR_EXTERNAL_METHODS>
  // The language the caller's mail is written in; the result is their user
  // record.
  locales: External<ClientService<User, LocaleData, never, never, Params>, typeof LOCALE_EXTERNAL_METHODS>
  // Metadata only: uploads and downloads are plain HTTP (FILES_URL,
  // FILE_CONTENTS_URL).
  files: Pick<ClientService<File, never, never, never, Params<FileQuery>>, 'get'>
  // GDPR exports the caller asked for; a ready one is downloaded over plain
  // HTTP (DATA_EXPORT_CONTENTS_URL).
  'data-exports': External<
    ClientService<DataExport, DataExportData, never, Paginated<DataExport>, Params<DataExportQuery>>,
    typeof DATA_EXPORT_EXTERNAL_METHODS
  >
  // Erasing a person (admin only); the result names the surrogate id.
  erasures: External<ClientService<Erasure, ErasureData, never, never, Params>, typeof ERASURE_EXTERNAL_METHODS>
  'audit-events': External<
    ClientService<AuditEvent, never, never, Paginated<AuditEvent>, Params<AuditEventQuery>>,
    typeof AUDIT_EVENT_EXTERNAL_METHODS
  >
  // Active sessions: the caller's own, everyone's for admins and operators.
  // `remove` revokes one; the result carries revokedAt.
  sessions: External<
    ClientService<Session, never, never, Paginated<Session>, Params<SessionQuery>>,
    typeof SESSION_EXTERNAL_METHODS
  >
  // Mail (ADR 0027), admins only: the kinds code declares, the active
  // wording per kind and locale, its revisions, and previews of unsaved
  // wording rendered against the kind's sample.
  'mail-kinds': External<ClientService<MailKindInfo, never, never, MailKindInfo[], Params>, typeof MAIL_KIND_EXTERNAL_METHODS>
  'mail-templates': External<
    ClientService<MailTemplate, never, MailTemplatePatch, MailTemplate[], Params<MailTemplateQuery>>,
    typeof MAIL_TEMPLATE_EXTERNAL_METHODS
  >
  'mail-template-revisions': External<
    ClientService<MailTemplateRevision, MailTemplateRevisionData, never, Paginated<MailTemplateRevision>, Params<MailTemplateRevisionQuery>>,
    typeof MAIL_TEMPLATE_REVISION_EXTERNAL_METHODS
  >
  'mail-previews': External<ClientService<MailPreview, MailPreviewData, never, never, Params>, typeof MAIL_PREVIEW_EXTERNAL_METHODS>
  // Campaigns, sent by hand after a preview for an actual recipient.
  'mail-campaigns': External<
    ClientService<MailCampaign, MailCampaignData, never, Paginated<MailCampaign>, Params<MailCampaignQuery>>,
    typeof MAIL_CAMPAIGN_EXTERNAL_METHODS
  >
  'mail-campaign-previews': External<
    ClientService<MailCampaignPreview, MailCampaignPreviewData, never, never, Params>,
    typeof MAIL_CAMPAIGN_PREVIEW_EXTERNAL_METHODS
  >
  // The delivery log: outcomes by surrogate id, never address or text.
  'mail-deliveries': External<
    ClientService<MailDelivery, never, never, Paginated<MailDelivery>, Params<MailDeliveryQuery>>,
    typeof MAIL_DELIVERY_EXTERNAL_METHODS
  >
  // The job queues, admins only (ADR 0024), with a `status` event carrying
  // a queue's new state whenever it changes.
  queues: External<ClientService<QueueStatus, never, never, QueueStatus[], Params>, typeof QUEUE_EXTERNAL_METHODS>
}

export type ClientApplication = Application<ClientServiceTypes>

// POST AUTHENTICATION_URL with { strategy: 'refresh' } answers with this and
// sets the rotated cookie; the socket then authenticates with the access
// token under the `jwt` strategy (ADR 0010, 0014).
export interface AuthenticationResponse {
  accessToken: string
  authentication: { strategy: string }
  user: User
}

// DELETE AUTHENTICATION_URL: the session is revoked. Where the login came
// from the IdP, the browser continues to idpLogoutUrl (ADR 0008).
export interface LogoutResponse {
  loggedOut: true
  idpLogoutUrl: string | null
}

// The application's Feathers client over the given connection. The access
// token is held in memory only, whatever the options say: the library's
// default is localStorage, which would defeat the session design (ADR 0010,
// 0014).
export const createClient = (
  connection: TransportConnection<ClientServiceTypes>,
  options: Partial<Omit<AuthenticationClientOptions, 'storage'>> = {}
): ClientApplication => {
  const client: ClientApplication = feathers()
  client.configure(connection)
  // A CommonJS module: under NodeNext its default import is the module
  // object, whose `default` is the configure function in Node and bundlers
  // alike.
  client.configure(authenticationClient.default({ ...options, storage: new MemoryStorage() }))
  return client
}
