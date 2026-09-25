#!/bin/sh
# First initialisation only (ADR 0003, 0004). Role passwords come from files
# the postgres-agent rendered (ADR 0023); nothing is taken from environment
# variables.
#
#   migrator  owns the schema; used by the migrate job over a direct
#             connection. CREATEDB so it can build test_template (ADR 0015).
#   app       the API, through PgBouncer; DML only, via app_rw.
#   worker    the worker (ADR 0024), the same way under its own name.
#   exporter  postgres-exporter (ADR 0022): statistics through pg_monitor,
#             no access to application data.
#   test      integration tests, through PgBouncer; DML via app_rw, and
#             CREATEDB for the per-worker test_w<N> databases.
set -eu

secret() { cat "/run/secrets/$1"; }

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  --set=migrator_pw="$(secret migrator_password)" \
  --set=app_pw="$(secret app_password)" \
  --set=test_pw="$(secret test_password)" \
  --set=worker_pw="$(secret worker_password)" \
  --set=exporter_pw="$(secret exporter_password)" <<'SQL'
CREATE ROLE app_rw NOLOGIN;
CREATE ROLE migrator LOGIN CREATEDB PASSWORD :'migrator_pw';
CREATE ROLE app LOGIN PASSWORD :'app_pw' IN ROLE app_rw;
CREATE ROLE test LOGIN CREATEDB PASSWORD :'test_pw' IN ROLE app_rw;
CREATE ROLE worker LOGIN PASSWORD :'worker_pw' IN ROLE app_rw;
CREATE ROLE exporter LOGIN PASSWORD :'exporter_pw' IN ROLE pg_monitor;

CREATE DATABASE app OWNER migrator;
REVOKE ALL ON DATABASE app FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE app TO app_rw;
SQL

# Default privileges for app_rw are set by the first migration, so the
# application database and test_template get them the same way.
