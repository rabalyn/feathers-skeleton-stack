// Browser-safe client entry point (ADR 0007). At runtime it may reach only
// the modules the dependency boundary allowlists (.dependency-cruiser.cjs):
// never Knex, pg, the SAML library, resolvers or hooks. Server types are
// imported with `import type`, which leaves nothing at runtime.
import { feathers, type Application, type ClientService, type Paginated, type Params, type TransportConnection } from '@feathersjs/feathers'
import authenticationClient, { MemoryStorage, type AuthenticationClientOptions } from '@feathersjs/authentication-client'
import type { DirectoryEntry, DirectoryPage, DirectoryQuery } from './services/directory/directory.schema.js'
import type { DIRECTORY_EXTERNAL_METHODS } from './services/directory/directory.js'
import type { DirectoryLookupData, DIRECTORY_LOOKUP_EXTERNAL_METHODS } from './services/directory/directory-lookups.js'
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
import type { ApiToken, ApiTokenData, ApiTokenQuery } from './services/api-tokens/api-tokens.schema.js'
import type { API_TOKEN_EXTERNAL_METHODS } from './services/api-tokens/api-tokens.js'
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
import type { Role, RoleData, RolePatch, RoleQuery } from './services/roles/roles.schema.js'
import type { ROLE_EXTERNAL_METHODS } from './services/roles/roles.js'
import type { UserRoles, UserRolesPatch, USER_ROLE_EXTERNAL_METHODS } from './services/roles/user-roles.js'
import type { ViewAs, ViewAsData, VIEW_AS_EXTERNAL_METHODS } from './services/view-as/view-as.js'
import type { Site, SitePage, SiteQuery } from './services/sites/sites.schema.js'
import type { SITE_EXTERNAL_METHODS } from './services/sites/sites.js'
import type { SystemInfoReport, SYSTEM_INFO_REPORT_EXTERNAL_METHODS } from './services/system-info/system-info.js'
import type { UpdateCheck, UpdateCheckData, UPDATE_CHECK_EXTERNAL_METHODS } from './services/update-checks/update-checks.js'
import type { Preference, PreferenceData, PreferenceQuery } from './services/preferences/preferences.schema.js'
import type { PREFERENCE_EXTERNAL_METHODS } from './services/preferences/preferences.js'
import type { Doc, DocQuery, DocSummary, DOC_EXTERNAL_METHODS } from './services/docs/docs.js'
import type { ProductServiceTypes } from './product/client.js'
import type { Location, LocationData, LocationPage, LocationQuery } from './services/locations/locations.schema.js'
import type { LOCATION_EXTERNAL_METHODS } from './services/locations/locations.js'
// gen:service imports (ADR 0030)

export type { User, UserPatch, UserQuery } from './services/users/users.schema.js'
export type { Role, RoleData, RolePatch, RoleQuery } from './services/roles/roles.schema.js'
export type { UserRoles, UserRolesPatch } from './services/roles/user-roles.js'
export type { ViewAs, ViewAsData } from './services/view-as/view-as.js'
export type { Setting, SettingPatch, SettingQuery } from './services/settings/settings.schema.js'
export type { SettingKey } from './settings/registry.js'
export type { DirectoryEntry, DirectoryPage, DirectoryQuery } from './services/directory/directory.schema.js'
export type { DirectoryLookupData } from './services/directory/directory-lookups.js'
export type { Document, DocumentData, DocumentPatch, DocumentQuery } from './services/documents/documents.schema.js'
export type { File } from './services/files/files.schema.js'
export type { AvatarData } from './services/users/avatars.js'
export type { LocaleData } from './services/users/locales.js'
export { DEFAULT_LOCALE, LOCALES, type Locale } from './locales.js'
export type { DataExport, DataExportData, DataExportQuery } from './services/data-exports/data-exports.schema.js'
export type { Erasure, ErasureData } from './services/erasures/erasures.js'
export type { AuditEvent, AuditEventQuery } from './services/audit-events/audit-events.js'
export type { Session, SessionQuery } from './services/sessions/sessions.js'
export type { ApiToken, ApiTokenData, ApiTokenQuery } from './services/api-tokens/api-tokens.schema.js'
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
export type { Site, SiteGroup, SitePage, SiteQuery } from './services/sites/sites.schema.js'
export { SITE_PAGE_MAX, SITE_SEARCH_MAX_LENGTH } from './limits.js'
export type { SystemComponent, SystemInfoReport } from './services/system-info/system-info.js'
export type { UpdateCheck, UpdateCheckData } from './services/update-checks/update-checks.js'
export type { Preference, PreferenceData, PreferenceQuery } from './services/preferences/preferences.schema.js'
export type { PreferenceKey, PreferenceValues } from './preferences/registry.js'
// A 400 for refused data or query (ADR 0005).
export type { ValidationError } from './validation-error.js'
export type { Doc, DocKind, DocQuery, DocSource, DocSummary } from './services/docs/docs.js'
export { DOC_SEARCH_MAX_LENGTH } from './limits.js'
export type { Location, LocationData, LocationPage, LocationQuery } from './services/locations/locations.schema.js'
export { LOCATION_NAME_MAX_LENGTH } from './limits.js'
// gen:service exports (ADR 0030)
// The product's part (ADR 0035).
export * from './product/client.js'
export { ALLOWED_CONTENT_TYPES, AVATAR_CONTENT_TYPES, FILENAME_HEADER, type AllowedContentType } from './uploads.js'
export {
  ADMIN_PERMISSIONS,
  PERMISSIONS,
  PERMISSION_KEYS,
  ROLE_KINDS,
  TOKEN_PERMISSION_KEYS,
  ROLE_MANAGEMENT,
  closureOf,
  defineAbilitiesFor,
  defineViewAsAbility,
  isPermissionKey,
  withRequirements,
  type AbilityUser,
  type AppAbility,
  type PermissionKey,
  type RoleKind
} from './abilities.js'
// For asking an ability about one record, as the server does.
export { subject } from '@casl/ability'
export { PAGINATE } from './paginate.js'
export {
  API_PREFIX,
  AUTHENTICATION_URL,
  DATA_EXPORT_CONTENTS_URL,
  FILE_CONTENTS_URL,
  FILES_URL,
  MAINTENANCE_PAGE,
  MAINTENANCE_URL,
  SAML_LOGIN_URL,
  SOCKET_PATH
} from './paths.js'
export {
  DIRECTORY_MAX_RESULTS,
  DIRECTORY_MAX_TERM_LENGTH,
  DIRECTORY_MIN_TERM_LENGTH,
  DIRECTORY_PAGE_MAX
} from './limits.js'

export type External<S, M extends readonly (keyof S)[]> = Pick<S, M[number]>

// The services as a browser sees them: only their external methods, with
// the shapes the schemas give them. The product's are in product/client.ts.
export interface ClientServiceTypes extends ProductServiceTypes {
  users: External<ClientService<User, never, UserPatch, Paginated<User>, Params<UserQuery>>, typeof USER_EXTERNAL_METHODS>
  settings: External<
    ClientService<Setting, never, SettingPatch, Paginated<Setting>, Params<SettingQuery>>,
    typeof SETTING_EXTERNAL_METHODS
  >
  directory: External<
    ClientService<DirectoryEntry, never, never, DirectoryPage, Params<DirectoryQuery>>,
    typeof DIRECTORY_EXTERNAL_METHODS
  >
  // One person by an attribute the product names (ADR 0008).
  'directory-lookups': External<ClientService<DirectoryEntry, DirectoryLookupData, never, never, Params>, typeof DIRECTORY_LOOKUP_EXTERNAL_METHODS>
  documents: External<
    ClientService<Document, DocumentData, DocumentPatch, Paginated<Document>, Params<DocumentQuery>>,
    typeof DOCUMENT_EXTERNAL_METHODS
  >
  // Roles and what they grant (ADR 0011): names for whoever reads users,
  // everything and every change for admins.
  roles: External<ClientService<Role, RoleData, RolePatch, Paginated<Role>, Params<RoleQuery>>, typeof ROLE_EXTERNAL_METHODS>
  // A user's roles, assigned by admins; the id is the user's.
  'user-roles': External<ClientService<UserRoles, never, UserRolesPatch, never, Params>, typeof USER_ROLE_EXTERNAL_METHODS>
  // Read-only view-as another person (ADR 0028): `create` starts it,
  // `remove('current')` ends it.
  'view-as': External<ClientService<ViewAs, ViewAsData, never, never, Params>, typeof VIEW_AS_EXTERNAL_METHODS>
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
  // Active sessions, under `sessions.read`.
  // `remove` revokes one; the result carries revokedAt.
  sessions: External<
    ClientService<Session, never, never, Paginated<Session>, Params<SessionQuery>>,
    typeof SESSION_EXTERNAL_METHODS
  >
  // API tokens (ADR 0029): one's own, or everybody's under
  // api-tokens.manage. The token itself is in the result of `create` only.
  'api-tokens': External<
    ClientService<ApiToken, ApiTokenData, never, Paginated<ApiToken>, Params<ApiTokenQuery>>,
    typeof API_TOKEN_EXTERNAL_METHODS
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
  // Locations (ADR 0031): the university's buildings from NetBox, read only.
  sites: External<ClientService<Site, never, never, SitePage, Params<SiteQuery>>, typeof SITE_EXTERNAL_METHODS>
  // What runs and which updates are out (ADR 0032), read only.
  'system-info': External<
    ClientService<SystemInfoReport, never, never, SystemInfoReport, Params>,
    typeof SYSTEM_INFO_REPORT_EXTERNAL_METHODS
  >
  'update-checks': External<
    ClientService<UpdateCheck, UpdateCheckData, never, never, Params>,
    typeof UPDATE_CHECK_EXTERNAL_METHODS
  >
  preferences: External<
    ClientService<Preference, PreferenceData, never, Paginated<Preference>, Params<PreferenceQuery>>,
    typeof PREFERENCE_EXTERNAL_METHODS
  >
  // The ADRs and diagrams (ADR 0019): a list, searchable, and each page's
  // Markdown.
  docs: External<ClientService<Doc, never, never, DocSummary[], Params<DocQuery>>, typeof DOC_EXTERNAL_METHODS>
  locations: External<
    ClientService<Location, LocationData, never, LocationPage, Params<LocationQuery>>,
    typeof LOCATION_EXTERNAL_METHODS
  >
  // gen:service client-types (ADR 0030)
}

export type ClientApplication = Application<ClientServiceTypes>

// POST AUTHENTICATION_URL with { strategy: 'refresh' } answers with this and
// sets the rotated cookie; the socket then authenticates with the access
// token under the `jwt` strategy (ADR 0010, 0014).
export interface AuthenticationResponse {
  accessToken: string
  authentication: { strategy: string }
  user: User
  // In a read-only view-as (ADR 0028): `user` is the person viewed as, and
  // this the one looking, until `viewAs.expiresAt`.
  viewer?: User
  viewAs?: { expiresAt: string }
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
