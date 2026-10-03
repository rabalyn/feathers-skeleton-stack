# NetBox: building lookup and NetBox login

Illustrates [0031](../0031-netbox-locations.md). Where this page and the ADR or the code disagree, the ADR and the code win.

NetBox sits on three networks of its own: `netbox-edge` (browsers via Nginx), `netbox-api` (the api) and `netbox-data` (its PgBouncer and Valkey access), so it has no route to the api or the worker.

## Building lookup from the application

```mermaid
sequenceDiagram
  autonumber
  actor b as Browser (Buildings page)
  participant api
  participant nb as netbox :8443 (netbox-api)
  participant pgb as pgbouncer :6432 (netbox-data)
  participant pg as postgres (database netbox)

  b->>api: sites.find {q: "S1"} (needs sites.read)
  api->>nb: GET /api/dcim/sites/?q=…<br>Authorization: v2 token of user feathers-api (view only)
  nb->>pgb: query
  pgb->>pg: query
  nb-->>api: sites (retired ones left out)
  api-->>b: page of sites in the user's language
  Note over api,nb: NetBox unreachable → 503,<br>it does not make the api unready.
```

## People logging in to NetBox

```mermaid
sequenceDiagram
  autonumber
  actor b as Browser
  participant ngx as nginx
  participant nb as netbox
  participant idp as idp (Keycloak)
  participant ldap

  b->>ngx: https://netbox.localhost:8443/
  ngx->>nb: HTTPS :8443 (netbox-edge)
  nb-->>b: redirect to IdP, NetBox's own SP key pair
  b->>idp: via nginx idp vhost
  idp->>ldap: bind, read ou=groups
  idp-->>b: assertion with "groups"
  b->>nb: POST assertion
  nb->>nb: create user (TU-ID) on first login,<br>netbox-admins → superuser,<br>sync membership of netbox-readers / netbox-editors
  nb-->>b: logged in
```

## Setup at every start

```mermaid
flowchart LR
  setup["netbox-setup (one-shot)"] -->|"db · :5432 direct"| pg[("postgres<br>database netbox")]
  setup -->|"migrate, then seed sites<br>from seed/tu-darmstadt/*.json<br>(upsert by slug, retire what the files<br>no longer list, never delete)"| pg
  setup -->|"seed the groups netbox-readers<br>and netbox-editors"| pg
  setup -->|"user feathers-api (view only),<br>create or replace its read-only v2 token"| pg
  setup --> start["netbox, netbox-worker start"]
```
