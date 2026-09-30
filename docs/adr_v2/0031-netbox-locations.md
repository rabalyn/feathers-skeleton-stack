# 0031: NetBox holds the university's locations, seeded from its published building list

- Status: Accepted
- Date: 2026-09-30
- Scope: Required (v1)
- Related: [0001](0001-one-stack-every-environment.md), [0002](0002-service-inventory-and-networks.md), [0003](0003-postgresql-and-knex.md), [0004](0004-pgbouncer-pools.md), [0008](0008-authentication-saml2-ldap.md), [0009](0009-tu-id-identity-model.md), [0010](0010-sessions-postgres-ratelimits-valkey.md), [0011](0011-casl-role-authorization.md), [0016](0016-nginx-and-tls-everywhere.md), [0017](0017-nfs-backup-storage.md), [0023](0023-secrets-management.md), [0030](0030-service-generator.md)

## Context

Products built on this skeleton record where things are on campus: the first one will install locks in rooms, and each lock must name its building and room. That needs one register of the university's buildings with their addresses, which people can extend with rooms, and which every application references instead of keeping its own copy.

The university offers no API for this. It publishes its buildings on a web page, the building addresses overview, whose keys (`S1|01`, `L2|10`) link to one page per campus; the campus pages add what each building houses and list buildings the overview lacks (the Hochschulstadion's `H1|…`). Every product here is a TU Darmstadt product ([0009](0009-tu-id-identity-model.md)), so this data belongs in the skeleton.

NetBox, a data-centre and network inventory, models exactly this: regions, nested site groups, sites with postal addresses, and locations (rooms, floors) nested inside a site, with a REST API, object-level permissions, a change log and SAML login. It runs as a container like the rest of the stack ([0001](0001-one-stack-every-environment.md)).

## Decision

### NetBox in the stack

- **NetBox 4.7** from the upstream image (`netboxcommunity/netbox`), pinned by digest, extended by `containers/netbox/Containerfile` with this stack's configuration (`config/feathers.py`, loaded after the image's own), the SAML group sync and the seed (`feathers_netbox/`), the seed files and the setup script. The seed data ships inside the image production pulls.
- Three services from that image ([0002](0002-service-inventory-and-networks.md)): **`netbox`**, the web UI and REST API (Granian, TLS on `:8443` with its own leaf, [0016](0016-nginx-and-tls-everywhere.md)); **`netbox-worker`**, its background jobs and housekeeping; and **`netbox-setup`**, a one-shot job that applies NetBox's migrations over a direct connection to PostgreSQL, as `migrate` does for the api ([0004](0004-pgbouncer-pools.md)), then seeds. `netbox` and `netbox-worker` start after it has succeeded.
- **Storage in the shared services.** A database `netbox` in the existing PostgreSQL, owned by a login `netbox`, which NetBox uses through PgBouncer in transaction mode (server-side cursors off) and `netbox-setup` directly. A Valkey user `netbox`, confined to RQ's queue keys (`rq:*`) and Django's cache keys (`:1:*`), in databases 0 and 1, without `@dangerous` commands ([0010](0010-sessions-postgres-ratelimits-valkey.md)). Uploaded images and attachments go to the `netbox-media` volume. One `netbox` login serves both the migrations and the runtime, unlike the api's migrator/app split ([0003](0003-postgresql-and-knex.md)): NetBox is a third-party application whose migrations are its own, and it owns nothing but its database.
- **Networks.** `netbox-edge` (Nginx and NetBox) for browsers; `netbox-api` (NetBox, the api, and locally api-e2e and the integration tests) for the REST calls; `netbox-data` (NetBox, its worker and setup, PgBouncer, Valkey), so NetBox reaches its database and Valkey without joining `app-data`, where the api and worker are.
- **Secrets** from OpenBao through a `netbox-agent` ([0023](0023-secrets-management.md)): the database and Valkey passwords, Django's secret key and the pepper NetBox hashes its v2 API tokens with (both generated at 96 characters, as NetBox requires at least 50), the SAML SP key pair, the IdP's certificate, and the secret of the api's token.
- **Self-contained** ([0001](0001-one-stack-every-environment.md)): `ISOLATED_DEPLOYMENT`, no census reporting, no release check, and NetBox Copilot, which loads a script from NetBox Labs, off.
- Browsers reach NetBox through Nginx under a host name of its own (`netbox.localhost` locally), with TLS on both hops. NetBox refuses anonymous access (`LOGIN_REQUIRED`).

### The data model

A **site is a building**, because in NetBox only sites carry a postal address:

| TU Darmstadt | NetBox |
| --- | --- |
| City (Darmstadt, Griesheim) | Region |
| Campus (`S` Stadtmitte) and section (`S1`) | Site group, the section nested in its campus |
| Building (`S1|01`) | Site: name `<key> <German designation>`, slug `s1-01`, facility the key, physical address `<street>\n<postal code> <city>`, a delivery address as shipping address, the English designation as description, other address remarks as comments, custom fields `name_en`, `occupants_de` and `occupants_en` |
| Room (later, by people or products) | Location inside the site |

Campuses and sections are areas of many buildings, not places anything is stored at; application records reference sites and, later, locations.

**Application records reference a site by its NetBox id.** So the id must be stable: the seed upserts by slug and never deletes, and a restore restores NetBox's database with the application's ([0017](0017-nfs-backup-storage.md)).

### The seed

- `containers/netbox/seed/scrape_tu_locations.py` (Python standard library only) reads the overview and every campus page it links to, in German and English, and writes `seed/tu-darmstadt/site-groups.json` and `sites.json`. Both languages are kept: the German designation is the official one and names the site, the English one and the occupants in both languages are stored beside it. A building only on a campus page gets the postal code of an overview building on the same street. The files are committed; the script is run by hand when the university changes its pages, and its diff reviewed.
- `netbox-setup` loads them at every start (`feathers_netbox/seed.py`, through NetBox's ORM, in one transaction): regions, site groups and sites upserted by slug, each tagged `seeded`. A seeded site the files no longer list is set to `retired`, never removed. Hand edits to seeded fields are overwritten at the next start; rooms and anything else added in NetBox are not touched.

### Access

- **The api reads with a v2 token of its own**, belonging to a NetBox user `feathers-api` without a password, whose only right is `view` on regions, site groups, sites and locations. The token's key is configuration (`NETBOX_TOKEN_KEY`, the same in the api and `netbox-setup`), its secret comes from OpenBao; `netbox-setup` creates it read-only, and replaces it when the secret changed, which is how it rotates.
- **The `sites` service** (`find`, `get`) is the address lookup and resolves the ids records store. `find` searches with NetBox's own search (key, name, address, description) and leaves retired buildings out; `get` returns any site, retired too. NetBox unreachable answers 503; it does not make the api unready. Reading sites is part of every signed-in person's baseline ([0011](0011-casl-role-authorization.md)): buildings are public knowledge, looked up by everyone who records where something is. API tokens do not carry the baseline ([0029](0029-api-tokens.md)), so a token cannot read sites until a product adds a permission for that.
- The web app's **Buildings** page searches the lookup, pages through every building, shows address and occupants in the user's language and links to the site in NetBox.
- **People log in to NetBox through the IdP** (SAML2, [0008](0008-authentication-saml2-ldap.md)), with an SP key pair of NetBox's own; there is no local NetBox superuser. People are created at their first login, with the TU-ID as username. **Their rights come from the IdP's groups**: at every login, the attribute `NETBOX_SAML_GROUPS_ATTRIBUTE` (`groups`) makes a member of any group in `NETBOX_SAML_SUPERUSER_GROUPS` (`netbox-admins`) a superuser, and a member of every NetBox group whose name the IdP sent; memberships the IdP no longer sends are removed. `netbox-setup` seeds two such groups: `netbox-readers` (view regions, site groups, sites, locations) and `netbox-editors` (maintain locations). What further groups may do is set in NetBox. Locally, LDAP holds these groups (`ou=groups`; ad01admn is an admin, op01oper an editor and reader, us01user a reader, us02othr in none), and Keycloak's LDAP group mapper and a group-list mapper on NetBox's client send them. NetBox's SAML library refuses an assertion that repeats an attribute name unless told otherwise, and Keycloak's role list does exactly that (seen 2026-09-30: every login failed), so NetBox accepts repeated names and merges their values; the group mapper sends all groups in one attribute.

## Consequences

- One register of buildings and rooms for every product, with a UI, a change log and permissions that the skeleton does not have to build.
- A large Python application joins the stack: three containers, a database, a Valkey user, a certificate, an agent and a virtual host, and its image joins the image scan ([0018](0018-owasp-security-baseline.md)). A NetBox upgrade is an image bump whose migrations `netbox-setup` applies.
- NetBox's cache shares Valkey's memory limit with rate limits and queues, and Valkey never evicts ([0010](0010-sessions-postgres-ratelimits-valkey.md)). NetBox caches little and with expiry; Valkey's memory is watched by the existing alerting ([0022](0022-observability-and-alerting.md)).
- The seed depends on the layout of the university's pages. A changed layout shows as a failing or strange scraper run, never at runtime, since the stack only reads the committed files.
- Referencing sites by NetBox id ties records to one NetBox instance: moving to another NetBox, or rebuilding it from the seed alone, would renumber every site. The backup of NetBox's database is therefore as necessary as the application's.
- The production IdP must release a group attribute to NetBox for anybody to get rights there. Which attribute the university IdP can release is not yet known; the attribute name is configuration.

## Open questions

- Which group attribute (and which groups) the university IdP releases to NetBox's SP.
