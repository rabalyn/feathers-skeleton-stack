# 0014: Frontend with Vue 3, Quasar and feathers-pinia

- Status: Accepted
- Date: 2026-09-23
- Scope: Required (v1)
- Supersedes: v1 ADRs 0029, 0030, 0031
- Related: [0007](0007-typed-client-from-api.md), [0010](0010-sessions-postgres-ratelimits-valkey.md), [0011](0011-casl-role-authorization.md), [0012](0012-role-scoped-channels.md), [0016](0016-nginx-and-tls-everywhere.md)

## Context

The frontend needs a component framework, a build tool, and state management that fits Feathers services and real-time events, and it must cooperate with a SAML2 redirect login and an in-memory access token.

## Decision

- **Vue 3** with the **Quasar Framework** on its Vite build, in **SPA mode**. No SSR, PWA, Capacitor or Electron.
- **`feathers-pinia`** for service state, querying, pagination and real-time synchronisation, as a **vendored fork** in `packages/feathers-pinia` (`@app/feathers-pinia`, private, never published). Upstream's last release, 4.5.4, supports Pinia 2 only and depends on `vue-demi`; the fork targets Pinia 4, Vue 3.5 and TypeScript 6 with upstream's whole test suite passing. The changes are listed in the package's README. It is built with `tsc` and consumed as built output, like the API client ([0007](0007-typed-client-from-api.md)). The fork is excluded from the repository's ESLint rules, as third-party code kept close to upstream, but is typechecked and tested in CI.
- TypeScript throughout, typechecked with `vue-tsc` in CI.
- The typed client is imported from the API package ([0007](0007-typed-client-from-api.md)).
- The production artifact is a static asset bundle, built in a Node stage and copied into an image that contains no Node runtime. It is served by Nginx ([0016](0016-nginx-and-tls-everywhere.md)), which also owns the SPA history fallback and cache headers. Lint, typecheck and unit tests run in CI, not inside the image build.
- Vue Router in **history mode**; Nginx serves `index.html` for unmatched paths.
- Under the `dev` Compose profile, a `web` container runs the Vite dev server with the source bind-mounted, and Nginx proxies to it instead of serving the bundle. Routing, TLS and origin stay the same. `scripts/stack.sh up --dev` starts it and sets `NGINX_WEB_UPSTREAM`, which switches Nginx from the bundle to the proxy at container start; plain `up` serves the bundle, which is what the end-to-end tests exercise. The switch covers every origin nginx serves, the e2e one included, so `scripts/stack.sh e2e` refuses to run while nginx proxies to the dev server rather than test Vite's development pages. The `dev` profile and the interpolated upstream never reach the generated Quadlet units ([0001](0001-one-stack-every-environment.md)).
- **Internationalisation from the first screen**: German is the default locale, English the second. All user-facing strings go through the i18n layer (`vue-i18n`, with Quasar's language packs for its own components); hard-coded UI text is a lint error. The catalogues are JSON files (`apps/web/src/i18n/<locale>.json`), because that is what the i18n lint reads: it rejects raw text in templates, a key the code uses that a catalogue lacks, and a key present in one catalogue but not the other. `vue/no-v-html` is an error as well.
- The CASL ability definitions are imported from the client export to hide actions the user may not take ([0011](0011-casl-role-authorization.md)). The server remains the only enforcement point.

### Two consequences of the authentication design the frontend must respect

- **The access token is kept in memory only.** The Feathers authentication client stores tokens in `localStorage` by default and `feathers-pinia`'s auth store builds on it, so in-memory storage must be configured explicitly. Left at the default, the design in [0010](0010-sessions-postgres-ratelimits-valkey.md) is silently defeated.
- **SAML login is a full-page redirect, not an XHR.** The app navigates the browser to `/api/auth/saml/login` and is returned to by the identity provider. On return, and on every reload or new tab, no access token exists in memory, so the app calls refresh on startup to re-establish the session from the cookie before rendering an authenticated view.
- **The break-glass login is a page of its own, `/break-glass`**, which nothing links to ([0008](0008-authentication-saml2-ldap.md)). It posts email and password to `/api/authentication`, which answers with the refresh cookie, and then starts the session with a refresh like every other page load. Wrong credentials, a rate-limited attempt and an unreachable service are told apart; which of email or password was wrong is not.

The client re-authenticates its WebSocket connection after every refresh and reconnect ([0012](0012-role-scoped-channels.md)). A failed refresh clears state, closes the socket and returns to login; a transient network error is distinguished from a rejected refresh so offline users are not logged out.

How the frontend implements this:

- Only **401 and 403** from refresh end the session. A network failure, 429 and every 5xx (including the 503 of a Valkey outage, [0010](0010-sessions-postgres-ratelimits-valkey.md)) keep it and retry with exponential backoff up to a minute; the page shows that the service is unreachable. At startup, the router waits for a real answer rather than sending the user to the login page.
- The access token is renewed a minute before it expires, and at once when a tab becomes visible again with a token about to expire, because background tabs have their timers throttled.
- Refreshes are serialised across tabs with the Web Locks API ([0010](0010-sessions-postgres-ratelimits-valkey.md)).
- The authentication client's own reconnect handling is switched off: it re-authenticates with the stored token and leaves the failure unhandled once that token has expired. The session store re-authenticates a reconnected socket instead, refreshing first where needed. A service call refused with 401 triggers a refresh, which tells a changed role (new token) from a revoked session (login).
- Service stores are never synchronised to browser storage: the data is personal, and a shared computer must not keep it. The only thing in `localStorage` is the chosen locale. A change of locale is also written to the user record, so mail reaches the person in the language they last used ([0027](0027-email-templates-and-sending.md)).
- Actions are hidden with the shared CASL abilities. A page for a whole subject (the users list, the settings editor) requires an unconditional rule, because everybody may read their own user record but only some may list users.
- GDPR ([0013](0013-gdpr-export-and-retention.md)): the profile has "My data", which requests and downloads the user's own export, and "My activity", the latest audit events they caused. Admins get a data requests page: they look a person up by TU-ID, export the person's data to hand over, or erase them. Erasure is confirmed by typing the TU-ID again, and the page says in advance when the server would refuse it. Admins and operators get the activity log, every audit event with its account shown by TU-ID.

## Consequences

- A large component library is available immediately, and Quasar's build handles the production bundle.
- `feathers-pinia` stalled upstream. The fallback this ADR first named, plain Pinia stores around the Feathers client, was not taken: the instance API and the stores that update themselves from service events are what the library is chosen for, and rebuilding them by hand is more code to own than the fork. The price is that keeping the fork current with Vue, Pinia and Feathers is now this project's job, and its tests run in CI for that reason. The plain-Pinia fallback remains open and stays contained, because the Feathers client itself is unaffected.
- Authenticated startup always costs one refresh round trip before the first render.
- Every new string needs a German and an English entry; a missing key is caught by the i18n lint rather than in review.
