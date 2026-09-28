# 0027: E-mail from code-declared mail kinds, with admin-edited Liquid templates, sent by the worker

- Status: Accepted
- Date: 2026-09-27
- Scope: Required (v1)
- Related: [0001](0001-one-stack-every-environment.md), [0003](0003-postgresql-and-knex.md), [0005](0005-typebox-schema-boundary.md), [0009](0009-tu-id-identity-model.md), [0011](0011-casl-role-authorization.md), [0013](0013-gdpr-export-and-retention.md), [0014](0014-frontend-quasar-vue.md), [0016](0016-nginx-and-tls-everywhere.md), [0018](0018-owasp-security-baseline.md), [0021](0021-structured-logging.md), [0022](0022-observability-and-alerting.md), [0023](0023-secrets-management.md), [0024](0024-background-jobs-bullmq.md), [0025](0025-runtime-settings.md)

## Context

Products built on the skeleton send mail in two ways. **Notifications** are consequences of something that happened in the application (a loan was registered, an export is ready). **Campaigns** go to many people at once (a reminder to every borrower whose locker key stops working within two weeks, listing those keys). Both carry text mixed with data only the product can compute, and the wording must be changeable without a release.

The alternatives considered were a self-hosted mail platform (Listmonk, Mautic, Keila), a notification platform (Novu), and building on the existing stack. A SaaS sender is not an alternative: products are self-contained ([0001](0001-one-stack-every-environment.md)). The platforms each bring a service with its own database, administrator login and copy of the recipients: more attack surface, another store for the GDPR registry and erasure, and another backup. They also cannot compute product data such as "the keys this person holds that expire soon" without an integration that is most of the work anyway. The existing stack already has the pieces: the worker and BullMQ ([0024](0024-background-jobs-bullmq.md)), TypeBox ([0005](0005-typebox-schema-boundary.md)), the audit trail and the personal data registry ([0013](0013-gdpr-export-and-retention.md)), and Mailpit in every environment.

## Decision

### Code declares what a mail can say and to whom; admins write the wording

A **mail kind** is declared in code with `defineMailKind()` and registered in one module, like the settings registry ([0025](0025-runtime-settings.md)). The skeleton provides the mechanism; each product declares its own kinds. A kind names:

| Part | Meaning |
| --- | --- |
| `key` | Stable identifier, namespaced by the product (`lending.key-expiry-reminder`) |
| `type` | `notification` (sent by code) or `campaign` (sent by an admin from the UI) |
| `params` | TypeBox schema of the input: surrogate ids for a notification, the admin's choices for a campaign (for example `horizonDays`) |
| `variables` | TypeBox schema of everything a template may use. The skeleton adds `recipient` (given name, surname) and `app` (name, public URL) to every kind |
| `build(db, userId, params)` | Computes the variables for one recipient, **at send time**, so the mail reflects the data when it leaves rather than when it was queued. Returning `null` skips the recipient |
| `recipients(db, params)` | Campaigns only: a query yielding the user ids to mail |
| `sample` | Example variables, for the editor's preview and for checking templates |
| `defaults` | Subject and body per locale, so a fresh stack sends mail before anyone edits a template |

Admins cannot create kinds: a template nothing sends and nothing supplies variables to is useless, and a recipient query is code, not configuration. Admins never write queries.

The skeleton registers two kinds of its own (`apps/api/src/mail/registry.ts`), which the end-to-end suite proves arrive:

- **`gdpr.export-ready`**, a notification: the worker sends it in the transaction that marks a GDPR export ready ([0013](0013-gdpr-export-and-retention.md)), to the account that asked for it, with a link to where that account fetches it. It is a feature of the skeleton; products keep it.
- **`documents.stale-reminder`**, a campaign on the example documents: every owner of documents unchanged for `olderThanDays` gets one mail listing them. It has the shape a product's campaign will have (the admin's choice as a parameter, a list per recipient built at send time), and a product replaces it with its own.

### Recipients are accounts

A mail always goes to a user id. The address is the user's directory email and the language is the user's `locale` ([0009](0009-tu-id-identity-model.md)). There are no free-form addresses, so export, erasure and the registry cover mail without anything new ([0013](0013-gdpr-export-and-retention.md)). At send time a recipient that is disabled, erased or without an email is skipped and recorded as such. The break-glass account is never a recipient.

The user record gains a **`locale`** column (`de` or `en`, default `de`, the UI's default). The web app writes it whenever the person changes language, through a service with no user id to address, like `avatars` ([0011](0011-casl-role-authorization.md)), so a mail arrives in the language the person last used.

### Templates: Liquid in Markdown, inside a layout owned by code

- A template is a **subject and a Markdown body per kind and locale**, written in **LiquidJS** with `strictVariables` and `strictFilters`, and a fixed filter set: `date`, `datetime` and `number`, formatted for the recipient's locale, and of LiquidJS's built-ins only `default`, `upcase`, `downcase`, `capitalize`, `size`, `first`, `last`, `join`, `plus`, `minus` and `round`. Any other filter fails the check on save. The set is small on purpose: every filter is one more thing to reason about next to the output escaping below. Liquid has no access to anything except the variables it is given, so an admin cannot reach server state through a template.
- On save, a template is checked against the kind's `variables` schema: every variable path it uses must exist, which LiquidJS's static analysis reports; it must then render against `sample` without error. A template that fails is refused with the offending line. Both locales must exist for every kind, as the i18n lint requires for the UI ([0014](0014-frontend-quasar-vue.md)).
- Rendering is Liquid, then Markdown (`markdown-it` with raw HTML disabled), then the **MJML layout in code**, which carries the product's name and the footer. The same Markdown is rendered to the plain-text part, a link as its text followed by its address. The layout is compiled once per locale, with markers where the subject and content go, so a mail costs no MJML run. Admins edit content, never the HTML frame, so they cannot break how the mail renders across clients.
- **Every value a template outputs is escaped for Markdown and HTML** (LiquidJS `outputEscape`). A person whose name contains `[x](https://…)` or `<img>` gets it shown as text, never as a link or markup.
- Links point at the application only, built from the public origin in deployment configuration (`app.url`): a link to any other origin fails rendering, so it fails the check on save. Markdown images are off, since a mail would load them from elsewhere; there is no `include` or `render`, so a template sees nothing but its own text; and LiquidJS's parse, render-time and memory limits bound what one template may cost.

### Revisions are immutable

Every save writes a new row of `mail_template_revisions` (kind, locale, subject, body, author, time); `mail_templates` points at the **active** revision per kind and locale. Admins see the history, compare revisions, and activate an older one to roll back. Saving and activating are audit events. `migrate` inserts each kind's code defaults as revisions by the system for every kind and locale it does not find, and never overwrites anything, as for settings ([0025](0025-runtime-settings.md)). A kind removed from code keeps its revisions but can no longer be sent.

### Notifications go through an outbox

Product code calls `mail.notify(trx, kind, userId, params)` **inside the transaction** of the write that causes it. That inserts a `pending` row into `mail_deliveries`, so the mail exists exactly when the write commits: never for a rolled-back write, and not lost when the process dies after the commit. This is the transactional outbox foreseen in [0024](0024-background-jobs-bullmq.md). After commit the API enqueues a job whose id is the delivery's id. A worker sweep every minute enqueues pending deliveries older than a minute, and BullMQ's job id deduplicates, so a lost enqueue is only a delay. The sweep runs on the `maintenance` queue, not on `mail`, whose rate limit would count it; a delivery still pending whose job has already failed (its last attempt could not even record the failure) is enqueued again.

`params` hold surrogate ids, never direct identifiers or rendered text ([0024](0024-background-jobs-bullmq.md)).

### Campaigns are sent by an admin, and only by hand

The **Mailings** page lists the campaign kinds. The admin picks one and fills its parameters in a form generated from the `params` schema (strings, numbers, dates, booleans and enums; nothing else is supported). The page shows the number of recipients and a preview rendered for one actual recipient, in each locale.

On confirmation the API writes a `mail_campaigns` row and an audit event (`mail.campaign.send`) in one transaction, pinning the active revision of each locale, so what is sent is what was previewed even if someone edits the template meanwhile. The worker then runs `recipients()`, writes one `mail_deliveries` row per recipient (unique per campaign and user, so a rerun adds no duplicates) and enqueues one job per delivery.

**There is no scheduled sending**, by decision: every campaign is started by a person, who sees the recipient count and the preview first. A product that wants a weekly reminder has an admin send it weekly.

### Sending

- The worker sends with **Nodemailer**: Mailpit locally and in CI, the university's internal SMTP server in production ([0022](0022-observability-and-alerting.md)). The worker already reaches `mail` on the `observability` network ([0002](0002-service-inventory-and-networks.md)). The API never talks SMTP.
- The SMTP server is **deployment configuration**, like the IdP and LDAP endpoints ([0025](0025-runtime-settings.md)), not a runtime setting: `SMTP_HOST`, `SMTP_PORT` and `MAIL_FROM`, the sender address. Grafana's alert mail uses the same values ([0022](0022-observability-and-alerting.md)).
- **There is no SMTP authentication.** The internal server accepts mail from the stack's hosts by their DNS names, so there is no SMTP secret in OpenBao ([0023](0023-secrets-management.md)).
- **TLS is always enforced**, and how follows from the port: `465` is implicit TLS; any other port requires STARTTLS, and a server that does not offer it fails the delivery. Nothing is ever sent in plaintext. The server's certificate is verified against the system roots and the CA root, like every other hop ([0016](0016-nginx-and-tls-everywhere.md)); `worker` refuses to start without the three values.
- Deliveries run on a queue of their own, `mail`, so a large campaign never delays the daily jobs or exports. Sending is throttled to `mailSendLimitCount` mails per `mailSendLimitWindowSeconds`, runtime settings shared by all worker processes; the default of **10 mails per 5 minutes** is the rate the previous applications sent at. A bulk send of 250, the expected maximum, takes a little over two hours; admins see how long a campaign will take before confirming it.
- A temporary SMTP failure (4xx, connection error) is retried with backoff, five attempts. A permanent failure (5xx) marks the delivery `failed` at once. A failed delivery logs at `error` with its delivery id, which raises the log alert ([0022](0022-observability-and-alerting.md)).
- Delivery is **at least once**: a worker that dies after the relay accepted a mail but before recording it sends that mail again. A duplicate reminder is accepted as the price of never silently dropping one.
- The worker exports counters of sent, failed and skipped mail per kind ([0022](0022-observability-and-alerting.md)).

### The delivery log

`mail_deliveries` keeps, per mail: recipient user id, kind, campaign, the revision used, `params`, status (`pending`, `sent`, `failed`, `skipped`), times, and the SMTP error. It holds **neither the address nor the rendered text**, so it adds no direct identifiers. It answers "did this person get the reminder, and in which wording" through the revision.

- Its retention is the runtime setting `mailDeliveryRetentionDays` (default 90), enforced by the daily retention cleanup ([0013](0013-gdpr-export-and-retention.md), [0024](0024-background-jobs-bullmq.md)).
- In the personal data registry it is exported with the person's data and **deleted** on erasure. `mail_campaigns` and `mail_template_revisions` reference their admin author and are `keep`, like audit events: they identify the account by surrogate id only.

### Access

Templates, campaigns and the delivery log are **admin only**: the wording of the application's mail is runtime behaviour, which is the admin's alone ([0011](0011-casl-role-authorization.md)). Operators neither see nor send. Notifications need no permission: code sends them as a consequence of a write the caller was already allowed to make.

## Consequences

- A product adds mail by declaring a kind: its data, its recipients and default wording, all typed and tested like any service. A misspelled variable fails when a template is saved, not in someone's inbox.
- Admins change wording without a release and can always roll back; they cannot change who receives mail or what data it can show.
- Mail after a write is exactly as durable as the write. The cost is an outbox sweep and at-least-once delivery.
- A template's power is deliberately small: Markdown and Liquid control flow over given variables, no raw HTML, no layout. A product that needs a different look changes the layout in code.
- Building variables at send time means a campaign of thousands runs `build()` thousands of times. Each call must be one indexed query or close to it; the kind's author owns that.
- Mail joins the registry, the retention table, the settings and the authorization matrix, and its tests join the end-to-end suite: a campaign and a notification are proven to arrive in Mailpit.

## Open questions

- The university relay's actual sending limit. The default of 10 mails per 5 minutes worked for the previous applications; whether the relay allows more is unconfirmed.
