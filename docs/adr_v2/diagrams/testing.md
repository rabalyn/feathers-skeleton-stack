# Test topology

Illustrates [0015](../0015-testing-vitest-playwright.md) and [0026](../0026-mcp-development-tooling.md). Where this page and an ADR or the code disagree, the ADR and the code win. None of this exists in production.

## Integration tests: one database per test file

`test` sits where the api sits (`app-data`, `identity`, `object`, `netbox-api`, `observability`), so it cannot bypass PgBouncer either.

```mermaid
flowchart LR
  migrate["migrate"] -->|"db · :5432<br>migrations once"| tmpl[("test_template")]

  subgraph test["test container (Vitest)"]
    w1["worker 1"]
    w2["worker 2"]
    wn["worker N"]
  end

  w1 -->|"CREATE DATABASE … TEMPLATE test_template"| d1[("test_w1_…")]
  w2 --> d2[("test_w2_…")]
  wn --> dn[("test_wN_…")]

  w1 & w2 & wn -->|"app-data · :6432<br>wildcard entry, pool max 2"| pgb["pgbouncer"]
  pgb -->|"db · :5432"| d1 & d2 & dn
  test -->|"app-data · :6379, any key"| valkey[("valkey")]
  test -->|"object · :3900<br>test-* buckets"| s3[("s3")]
  test -->|"identity · :636"| ldap[("ldap")]
  test -->|"observability · :1025"| mail["mail"]
  test -->|"observability · :9090"| prom[("prometheus")]
  test -->|"netbox-api · :8443"| netbox["netbox"]
```

## End-to-end: a second api on its own database

```mermaid
flowchart LR
  subgraph e2eBox["e2e container (Playwright, Chromium)"]
    pw["browser<br>host-resolver: *.localhost → nginx"]
  end

  pw -->|"edge · HTTPS :8443<br>e2e.localhost"| nginx["nginx"]
  pw -->|"idp-edge · HTTPS :8443<br>idp.localhost"| nginx
  pw -->|"mail.localhost, netbox.localhost"| nginx

  nginx -->|"edge · HTTP :3030"| apiE2e["api-e2e"]
  nginx -->|"idp-edge"| idp["idp"]

  apiE2e -->|":6432"| pgb["pgbouncer"] -->|":5432"| appE2e[("app_e2e")]
  workerE2e["worker-e2e"] -->|":6432"| pgb
  apiE2e & workerE2e -->|"e2e-uploads, e2e-exports"| s3[("s3")]
  apiE2e & workerE2e -->|"own key prefixes"| valkey[("valkey")]
  workerE2e -->|":1025"| mail["mail"]
```

Shared with the developer's stack: PostgreSQL, PgBouncer, Valkey, Keycloak, LDAP, Garage. Shared data: none.

## The coding agent's browser

```mermaid
flowchart LR
  agent(["Coding agent on the host"]) -->|"podman exec: Playwright MCP server"| mcp["mcp-browser"]
  mcp -->|"mcp-edge (internal, no route out)<br>HTTPS :8443"| nginx["nginx"]
  nginx --> app["app.localhost, idp.localhost,<br>netbox.localhost"]
```
