# Startup order and secret delivery

Illustrates [0023](../0023-secrets-management.md), [0016](../0016-nginx-and-tls-everywhere.md) (the `certs` job) and the start sequence of `scripts/stack.sh up`. Where this page and an ADR or the script disagree, the ADR and the code win.

## Start sequence

`depends_on` in `compose.yaml` covers part of the order; the rest is `scripts/stack.sh up`, because OpenBao must be unsealed and every agent given a `secret_id` before anything that reads a secret starts. In production an administrator does the unseal step with `scripts/openbao.sh unseal`, and systemd follows the same dependencies through the generated Quadlet units.

```mermaid
flowchart TD
  build["compose build"] --> certs["certs (one-shot)<br>local CA + one leaf per listener"]
  certs --> openbao["openbao starts sealed"]
  openbao --> agents["every *-agent starts<br>(no credential yet)"]
  agents --> setup["stack.sh setup<br>init or unseal OpenBao,<br>generate missing secret values,<br>issue wrapped secret_ids"]
  setup --> services["postgres, pgbouncer, valkey, s3,<br>ldap, idp, nginx, observability, …"]
  services --> pgHealthy{"postgres healthy?"}
  pgHealthy --> migrate["migrate (one-shot)<br>Knex migrations,<br>seed runtime settings"]
  migrate --> appJobs["api, worker, backup<br>(api and worker refuse to start<br>without the seeded settings)"]
  appJobs --> netboxSetup["netbox-setup (one-shot)<br>NetBox migrations, seed,<br>api's NetBox token"]
  netboxSetup --> netbox["netbox, netbox-worker"]
  netbox --> init["backup init (local volume only)"]
  init --> idpSetup["idp_setup<br>exchange SAML certificates<br>between idp and OpenBao,<br>restart api and netbox<br>(on a first start the api comes up here:<br>it needs the IdP certificate)"]
  idpSetup --> breakglass["bootstrap break-glass account,<br>give test accounts their roles"]
```

## Secret delivery

One OpenBao Agent per consuming service. The service itself is never on `secrets` and never talks to OpenBao; it reads files.

```mermaid
flowchart LR
  subgraph secretsNet["network: secrets"]
    openbao[("openbao<br>HTTPS :8200<br>KV v2 kv/&lt;service&gt;")]
    apiAgent["api-agent"]
    workerAgent["worker-agent"]
    otherAgents["postgres-agent, pgbouncer-agent,<br>valkey-agent, s3-agent, backup-agent,<br>netbox-agent, grafana-agent, …"]
    backup["backup"]
  end

  apiAgent -->|"AppRole login,<br>read kv/api"| openbao
  workerAgent -->|"AppRole login,<br>read kv/worker"| openbao
  otherAgents -->|"AppRole login,<br>read kv/&lt;service&gt;"| openbao
  backup -->|"raft snapshot only"| openbao

  apiAgent -->|"renders files"| apiTmpfs[/"tmpfs volume<br>/run/secrets/*"/]
  workerAgent -->|"renders files"| workerTmpfs[/"tmpfs volume<br>/run/secrets/*"/]

  apiTmpfs -->|"mounted read-only"| api["api<br>DATABASE_PASSWORD_FILE=…"]
  workerTmpfs -->|"mounted read-only"| worker["worker"]
```

How an agent gets its first credential, and why a restarted agent needs a new one:

```mermaid
sequenceDiagram
  autonumber
  actor admin as Administrator<br>(stack.sh locally, openbao.sh in production)
  participant bao as openbao :8200
  participant agent as api-agent
  participant tmpfs as tmpfs /run/secrets
  participant api

  admin->>bao: unseal (key share)
  admin->>bao: issue secret_id for AppRole "api",<br>response-wrapped
  admin->>agent: podman exec: hand over the wrapping token
  agent->>bao: unwrap → secret_id<br>(kept in the agent's own tmpfs only)
  agent->>bao: AppRole login (role_id from config + secret_id)
  bao-->>agent: token, policy: read kv/api only
  agent->>bao: read kv/api
  agent->>tmpfs: write database_password, auth_signing_secret, saml_sp_key, …
  api->>tmpfs: read *_FILE paths at startup
  Note over agent,tmpfs: The secret_id lives as long as the agent container.<br>A stopped or recreated agent needs a new one (unseal or reissue).<br>The rendered files stay while the service runs.
  loop every minute
    agent->>bao: read kv/api again
    agent->>tmpfs: re-render a changed value, then the service is restarted to pick it up
  end
```
