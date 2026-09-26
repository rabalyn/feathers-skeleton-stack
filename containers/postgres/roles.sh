#!/bin/sh
# The roles and the application database (ADR 0003, 0004), made to match
# this file on every start of postgres: by the image's first initialisation
# (initdb/10-roles.sh) and, afterwards, by entrypoint.sh once the server
# accepts connections. A role that is missing is created, every login's
# password is set from the file the postgres-agent rendered (ADR 0023), so a
# role added here reaches clusters that already exist, and a rotated
# password takes effect with a restart. Runs as the superuser over the local
# socket; nothing is taken from environment variables.
#
#   migrator  owns the schema; used by the migrate job over a direct
#             connection. CREATEDB so it can build test_template (ADR 0015).
#   app       the API, through PgBouncer; DML only, via app_rw.
#   worker    the worker (ADR 0024), the same way under its own name.
#   exporter  postgres-exporter (ADR 0022): statistics through pg_monitor,
#             no access to application data.
#   backup    the backup service's pg_dump and its runtime settings
#             (ADR 0017, 0025), over a direct connection: reads every table
#             through pg_read_all_data, writes nothing.
#   test      integration tests, through PgBouncer; DML via app_rw, and
#             CREATEDB for the per-worker test_w<N> databases.
set -eu

secret() { cat "/run/secrets/$1"; }

psql -v ON_ERROR_STOP=1 -q --username postgres --dbname postgres \
  --set=migrator_pw="$(secret migrator_password)" \
  --set=app_pw="$(secret app_password)" \
  --set=test_pw="$(secret test_password)" \
  --set=worker_pw="$(secret worker_password)" \
  --set=exporter_pw="$(secret exporter_password)" \
  --set=backup_pw="$(secret backup_password)" <<'SQL'
SELECT format('CREATE ROLE %I', name) FROM (VALUES
  ('app_rw'), ('migrator'), ('app'), ('test'), ('worker'), ('exporter'), ('backup')
) AS wanted (name)
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = name) \gexec

ALTER ROLE app_rw NOLOGIN;
ALTER ROLE migrator LOGIN CREATEDB PASSWORD :'migrator_pw';
ALTER ROLE app LOGIN PASSWORD :'app_pw';
ALTER ROLE test LOGIN CREATEDB PASSWORD :'test_pw';
ALTER ROLE worker LOGIN PASSWORD :'worker_pw';
ALTER ROLE exporter LOGIN PASSWORD :'exporter_pw';
ALTER ROLE backup LOGIN PASSWORD :'backup_pw';

SET client_min_messages = warning;
GRANT app_rw TO app, test, worker;
GRANT pg_monitor TO exporter;
GRANT pg_read_all_data TO backup;
RESET client_min_messages;

SELECT 'CREATE DATABASE app OWNER migrator'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'app') \gexec

REVOKE ALL ON DATABASE app FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE app TO app_rw;
GRANT CONNECT ON DATABASE app TO backup;
SQL

# Default privileges for app_rw are set by the first migration, so the
# application database and test_template get them the same way.
