# 0041: PostgreSQL operations baseline (storage, tuning, major upgrades)

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (production)
- Source: [Technical architecture › PostgreSQL operations, Production](../technical-architecture.md#postgresql-operations)
- Related: [0011](0011-postgresql-17.md), [0014](0014-pgbouncer-session-pooling.md), [0015](0015-database-roles-and-connection-paths.md), [0035](0035-private-podman-networks.md), [0065](0065-alerting.md)

## Context

PostgreSQL is operated by this deployment on the production host, with no managed database service behind it.

## Decision

- Production PostgreSQL uses a dedicated persistent host volume, separate from S3 and observability storage.
- Alert at 80% capacity. Monitor I/O, connections, checkpoints, and WAL growth.
- Keep `fsync` and synchronous commit enabled. Use PostgreSQL defaults until measured workload data justifies tuning.
- Major-version upgrades initially: create a new database volume, restore a tested dump, validate the database, and switch the deployment during a controlled maintenance window.
- PostgreSQL data receives connection details only through environment variables or a secret mechanism, never from committed files.

## Consequences

- Durability is never traded for speed.
- Major upgrades need downtime proportional to database size.

## ToDos

- ToDo: [Missing] PostgreSQL volume size. Sizes are given for monitoring volumes but not for the database or S3.
- ToDo: [Missing] Monitoring I/O, connections, checkpoints, WAL growth, and disk capacity needs a PostgreSQL exporter and node/host metrics. Neither is in the service inventory or network plan (ADR 0035).
- ToDo: [Clarify] Dump-and-restore upgrade duration against the 4-hour RTO (ADR 0047), and who schedules and announces maintenance windows.
- ToDo: [Clarify] PostgreSQL's default `max_connections` (100) interacts with the session-pooling limits (ADR 0014). Confirm the defaults fit.
- ToDo: [Clarify] "Dedicated persistent host volume": a Podman named volume or a host path on a dedicated filesystem?
- ToDo: [Clarify] Minor-update cadence and process (ADR 0011).
