# 0011: Role-based authorization with feathers-casl and a default-deny boundary

- Status: Accepted
- Date: 2026-09-23
- Scope: Required (v1)
- Supersedes: v1 ADRs 0021, 0063
- Related: [0005](0005-typebox-schema-boundary.md), [0007](0007-typed-client-from-api.md), [0008](0008-authentication-saml2-ldap.md), [0009](0009-tu-id-identity-model.md), [0010](0010-sessions-postgres-ratelimits-valkey.md), [0012](0012-role-scoped-channels.md), [0013](0013-gdpr-export-and-retention.md), [0024](0024-background-jobs-bullmq.md), [0025](0025-runtime-settings.md), [0027](0027-email-templates-and-sending.md), [0028](0028-read-only-view-as.md), [0029](0029-api-tokens.md)

## Context

Access needs to be configurable per route at a fine grain, while day-to-day reasoning happens in terms of a few named roles rather than individual rules. As a skeleton, this repository fixes the mechanism; each product adds permissions for its own resources.

What operators and users may see differs between the products built on this skeleton, and between deployments of one product. Until 2026-09-29 the three roles were fixed in code, so adjusting them meant a release. They are now data an admin edits, over a vocabulary of permissions that stays in code. Editing raw CASL rules in the UI was rejected: conditions, field lists and feathers-casl's need for `read` beside `create` are easy to get wrong, and a wrong rule exposes data. Decided 2026-09-29; built in slice 12.

## Decision

### Permissions are declared in code, roles are composed in the database

- A **permission catalogue** in the ability module declares every grantable permission: a stable key (`documents.all`), the group it is shown under, and a function from the user to its CASL rules, conditions and field lists included. It is the one place where rules are written. A product adds entries for its resources in `apps/api/src/product/permissions.ts`, which the catalogue appends ([0035](0035-products-derived-from-the-skeleton.md)); labels and descriptions are the web app's translations, keyed by the permission key, and a test refuses a key without both.
- A **fixed core** of rules applies to every signed-in account and is not in the catalogue, so no role can withdraw it: the own user record, which also carries the account's permissions; the own GDPR export, requested, listed and downloaded ([0013](0013-gdpr-export-and-retention.md)); and ending one's own view-as ([0028](0028-read-only-view-as.md)). The export is the complete copy the right of access and portability require (Art. 15, 20 GDPR): it holds the person's files, audit events and sessions, so seeing them live is not part of the core. Reading a file's bytes is open too, since it checks the caller's rule on the file's owner or on the record that attaches it and so grants nothing a permission over files, documents or users does not ([0020](0020-object-storage-uploads.md)). An API token does not get the core: it holds only the permissions chosen for it ([0029](0029-api-tokens.md)). Decided 2026-10-01; until then a wider **baseline** held everything the `everyone` role is now seeded with.
- A **role** is a row of `roles`: a key, a name per locale (`de` and `en`, both required, [0027](0027-email-templates-and-sending.md)) and a kind. `role_permissions` holds the catalogue keys each role grants. A key that code no longer declares is ignored when abilities are built and dropped by the next migration.
- Users hold **any number of roles** through `user_roles`; their permissions are the union of their roles' permissions and those of `everyone`, on top of the fixed core. A user with no role has what `everyone` grants and the fixed core.
- There are four kinds of role:

| Kind | Roles | Permissions | Deletable |
| --- | --- | --- | --- |
| Fixed | `admin` | Every catalogue permission, including those added later, and role management; not stored, not editable | No |
| Everyone | `everyone` | Stored, editable by an admin; held by every signed-in account without an assignment, and refused (**400**) as one; seeded with the former baseline beyond the fixed core | No |
| Seeded | `operator`, `user` | Stored, editable by an admin; seeded with the defaults below | No |
| Custom | created by an admin | Stored, editable by an admin | Yes, while nobody holds it; otherwise **409** |

- **Every catalogue permission is grantable**, configuration included. The line "configuration is the admin's alone", which other ADRs state for settings, mail and queues, describes the seeded defaults, not a guarantee. Only **role management** and the fixed core are outside the catalogue: creating, editing and deleting roles and assigning them to users is `admin`'s alone. Nobody else can change what anybody may do, themselves included.
- A new account gets `user` on its first login ([0008](0008-authentication-saml2-ldap.md)), or when product code makes it before that ([0009](0009-tu-id-identity-model.md#accounts-before-the-first-login)). The break-glass account holds `admin`, that assignment cannot be removed, and the account cannot be disabled ([0008](0008-authentication-saml2-ldap.md)), so the application always has an administrator.
- A catalogue permission added later is granted to `admin` at once and to no other role until an admin grants it. Where a product wants it seeded for `operator` or `user`, the migration that introduces it inserts those rows, once; after that the database is authoritative.

### Seeded defaults

The permission matrix, now as catalogue permissions. `admin` holds all of them. The fixed core applies to everyone, and `everyone` is seeded with the own-data permissions; none of these is a token permission ([0029](0029-api-tokens.md)).

| Permission | Covers | `everyone` | `operator` | `user` |
| --- | --- | --- | --- | --- |
| (fixed core) | Own user record read; own GDPR export: request, list, download; ending one's own view-as | always | always | always |
| `profile.avatar` | Own avatar: set, remove | ✓ | — | — |
| `profile.locale` | Own mail language | ✓ | — | — |
| `profile.preferences` | Own preferences, such as the navigation order ([0014](0014-frontend-quasar-vue.md), decided 2026-10-02) | ✓ | — | — |
| `files.upload` | Upload files ([0020](0020-object-storage-uploads.md)) | ✓ | — | — |
| `files.own` | Own files: read, download | ✓ | — | — |
| `audit-events.own` | Own audit events, those one caused | ✓ | — | — |
| `roles.own-names` | The names of one's own roles | ✓ | — | — |
| `api-tokens.own` | Own API tokens: read, revoke ([0029](0029-api-tokens.md)) | ✓ | — | — |
| `users.read` | All user records and their avatars; role names | — | ✓ | — |
| `users.enable` | Account enable / disable | — | — | — |
| `directory.read` | Directory lookup (LDAP) | — | ✓ | — |
| `sites.read` | Buildings from NetBox ([0031](0031-netbox-locations.md)) | — | ✓ | ✓ |
| `documents.own` | Documents: create; read, write, delete own | — | — | ✓ |
| `documents.all` | Documents: create; read, write, delete all; a document's file: own only (below) | — | ✓ | — |
| `sessions.read` | Sessions: read, without the user agent | — | ✓ | — |
| `sessions.read-user-agent` | Sessions: the user agent too | — | — | — |
| `sessions.revoke` | Sessions: revoke any | — | — | — |
| `audit-events.read` | All audit / activity events | — | ✓ | — |
| `data-exports.any` | GDPR export for any user | — | — | — |
| `erasures.create` | GDPR erasure | — | — | — |
| `settings.manage` | Runtime settings, feature flags, maintenance mode ([0025](0025-runtime-settings.md)); also what lets a person in while maintenance mode is on | — | — | — |
| `mail.manage` | Mail templates, campaigns, delivery log ([0027](0027-email-templates-and-sending.md)) | — | — | — |
| `queues.read` | Job queues: state, schedules, jobs ([0024](0024-background-jobs-bullmq.md)) | — | — | — |
| `users.view-as` | Read-only view as another user ([0028](0028-read-only-view-as.md)) | — | — | — |
| `api-tokens.create` | Create API tokens of one's own, and use them ([0029](0029-api-tokens.md)) | — | — | — |
| `api-tokens.manage` | Everybody's API tokens: read, revoke ([0029](0029-api-tokens.md)) | — | — | — |
| `docs.read` | The ADRs and diagrams on the architecture page ([0019](0019-adr-convention.md#diagrams), decided 2026-10-05); they describe the stack's services, ports and networks, so no seeded role holds it | — | — | — |
| (role management) | Roles, their permissions, role assignment | `admin` only, not grantable | | |

Directory-sourced user fields are never writable by anyone in the application ([0009](0009-tu-id-identity-model.md)). Backups are not triggered through the application at all: they run on their configured schedule ([0017](0017-nfs-backup-storage.md)), and their schedule and retention are runtime settings covered by `settings.manage`.

### Managing roles

- `roles` is a service: `find` and `get` for `admin`, and the key and name for anyone with `users.read`, who sees them on user records; `create`, `patch` and `remove` for `admin` only. A patch carries the name and the full list of permission keys; a key the catalogue does not declare is a **400**. The `admin` row refuses every patch and removal; `everyone` and the seeded roles refuse removal. A change to what `everyone` grants ends every signed-in connection but the calling admin's, whose rights do not depend on it and whose answer would otherwise be lost, as a change to any role ends its holders' ([0012](0012-role-scoped-channels.md)).
- Role assignment is the `user-roles` service, `admin` only, rather than a field of `users.patch`: feathers-casl would refuse or drop a field-restricted patch before schema validation (see uploads below). `users.patch` keeps `enabled`, under `users.enable`.
- Every change is audited in the same transaction ([0013](0013-gdpr-export-and-retention.md)): `roles.create`, `roles.patch` with the added and removed keys and the changed names, `roles.remove`, and `users.roles` with the added and removed role ids.
- A change to a role's permissions ends the connections of everyone who holds it, and a change to a user's roles ends that user's, so no socket keeps the rights it was granted under ([0012](0012-role-scoped-channels.md)).
- The permissions page, `admin` only, shows the catalogue as rows grouped as declared and the roles as columns, `admin` fixed and checked. It creates, renames and deletes roles, and offers a **role preview**: the page renders the navigation and actions as a chosen role would see them, by building that role's ability in the browser. The preview is presentation only; the data on screen is still read with the admin's rights. Seeing a real person's data as they do is view-as ([0028](0028-read-only-view-as.md)).

### Enforcement

- `feathers-casl` enforces the ability built from the fixed core and the catalogue entries of the caller's permissions. Rules are declared in one module, not scattered across services.
- `@casl/ability` stays on 6.x while feathers-casl 3 is current: CASL 7 removed `rulesToQuery`, which feathers-casl 3 imports, and patching feathers-casl locally was rejected, since it would make us the maintainers of a fork of the authorization layer. Renovate holds the CASL major (`allowedVersions`) until a feathers-casl release supports CASL 7, which then moves together with it. Decided 2026-10-01.
- The caller's permissions are loaded on every request, beside the session check ([0010](0010-sessions-postgres-ratelimits-valkey.md)), in one query over `user_roles`, `roles` and `role_permissions`. There is no cache, so a changed role or assignment applies on the user's very next request. A call with an API token is authorized by the token's permissions that its owner holds, loaded the same way ([0029](0029-api-tokens.md)).
- A **global default-deny hook** requires authentication and authorization on every service. Public endpoints are an explicit allowlist, each rate-limited where it accepts credentials:
  - `GET /api/ping`,
  - the SAML routes under `/api/auth/saml/`: metadata, login, ACS and logout,
  - the `/api/authentication` endpoint for refresh, logout and the break-glass password login.
- Health, readiness and metrics are not on the public port at all ([0022](0022-observability-and-alerting.md)), so they need no allowlist entry.
- For `find` and `get`, CASL conditions are translated into Knex query conditions, so a query under `documents.own` is scoped to owned rows by the authorization layer rather than by each service remembering to filter.
- A read the caller is not permitted is answered exactly like a read of a record that does not exist — **404** — so a response never confirms that a record exists. A denied write on a record the caller may read is a **403**. Lists are scoped silently, as above.
- Uploads follow the permissions above ([0020](0020-object-storage-uploads.md)): a file's metadata and bytes are readable by its owner under `files.own`; its bytes, besides, by whoever may read the record attaching it: the user whose avatar it is, the document whose file it is. No permission grants files wholesale, so knowing a file's id is never enough, and a file the caller may not read is a **404** worded like one that does not exist. Decided 2026-10-02; until then `users.read` and `documents.all` read every file whose id the reader knew. Uploading is `files.upload`, which `everyone` holds as seeded. Only a document's owner replaces its file: a holder of `documents.all` may rename or delete someone else's document, but a `fileId` in their patch is a **403**, since attaching needs a file of the caller's own and would put their file into the owner's document, where the owner could neither download it nor find it in their export ([0013](0013-gdpr-export-and-retention.md)). Decided 2026-09-28. The own avatar is written through an `avatars` service that has no user id to address, rather than through a field-restricted `users.patch` rule: feathers-casl would drop or refuse fields before schema validation and answer 404 instead of 403 for a record the caller may read.
- Field-level restrictions are enforced by the external resolver ([0005](0005-typebox-schema-boundary.md)), so a permitted read cannot leak a forbidden field. Where a permission reads a record but not all of its fields, the rule is a CASL field rule in its catalogue entry and the resolver asks the caller's ability for it: `feathers-casl` filters only the internal result, never the payload the transport sends, while its channel helpers filter each published event by that same field rule ([0012](0012-role-scoped-channels.md)). Rules of several permissions add up: `sessions.read` with `sessions.read-user-agent` reads every field. feathers-casl intersects every field rule that matches a record, whatever broader rule applies beside it, so the ability module drops a field rule wherever a rule without fields or conditions grants the same actions on the same subject.
- Sessions ([0010](0010-sessions-postgres-ratelimits-valkey.md)) are a `sessions` service over `auth_sessions` with `find`, `get` and `remove`, for seeing who is logged in; no own-data permission reaches it, not even for their own sessions, which reach them through their data export ([0013](0013-gdpr-export-and-retention.md)). It lists **active sessions only**; revoked and expired ones are in the audit log, not in the list. `remove` revokes: it sets `revoked_at`, ends the session's sockets and records `sessions.revoke`, but keeps the row, which reuse detection needs until the family expires. `sessions.read` reads every session but no user agent, the reader's own included; `sessions.read-user-agent` adds it and `sessions.revoke` ends any. Sessions are created by logging in, not through the service, so the session store publishes its changes as the service's events: a login as `created`, a refresh as `patched`, every revocation (the service's, logout, reuse detection) as `removed`. An expiry is not an event; it drops out of the list on its next query. The Sessions page marks the viewer's own session from the access token's session id. Decided 2026-09-28.
- The frontend imports the same ability module and catalogue through the client export ([0007](0007-typed-client-from-api.md)) to hide actions the user may not take. The server sends the caller's effective permission keys with their own user record, and the browser builds the ability from them. This is presentation only; the server remains the only enforcement point.

## Consequences

- Adding a service means adding its catalogue entries; the default-deny hook makes the failure mode "nobody but `admin` can use it yet" rather than "everybody can".
- The seeded defaults above are the specification for the authorization tests: each cell should have one. The tests run against roles of their own holding exactly the permissions in question, not against the seeded roles, which a product may change ([0035](0035-products-derived-from-the-skeleton.md), decided 2026-10-06); that the seeded roles grant the defaults is checked once, in the skeleton only. Each catalogue entry has a test of its own rules, and the role management safeguards (fixed `admin`, undeletable seeded roles, 409 on a held role, the break-glass assignment) have theirs.
- A deployment can grant configuration to operators. That is a deliberate choice of the admin who makes it, and it is audited, but the skeleton no longer guarantees that only admins see configuration.
- Multiple roles make "what may this person do" a union to compute rather than a name to read. The Users page shows the roles; the permissions page shows what they add up to.
- The ability module and catalogue ship to the browser, so they must not import server-only code; the boundary lint rule in [0007](0007-typed-client-from-api.md) covers it.
- `users.role` gives way to `user_roles`, through the expand and contract steps of [0003](0003-postgresql-and-knex.md); the role channels give way to subject channels ([0012](0012-role-scoped-channels.md)).
