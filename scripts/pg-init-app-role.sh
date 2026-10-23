#!/bin/sh
# Creates the role the server and the backups connect as, and hands it the
# database. Runs by itself when a volume is first initialised
# (docker-entrypoint-initdb.d), and is safe to run again: that is how an
# existing instance is brought in line, and how the role's password changes.
#
# The role is not a superuser. It owns the database, its schema and every
# table, which is all the migrations need; what it cannot do is reach outside
# the database — no COPY ... PROGRAM, no reading the server's files.
set -eu

: "${APP_DB_USER:?set APP_DB_USER}" "${APP_DB_PASSWORD:?set APP_DB_PASSWORD}"
# Run against the superuser itself, this would strip it of SUPERUSER.
if [ "$APP_DB_USER" = "$POSTGRES_USER" ]; then
	echo "pg-init-app-role: APP_DB_USER must differ from POSTGRES_USER" >&2
	exit 1
fi

# The password reaches psql through the environment, never its arguments.
psql -v ON_ERROR_STOP=1 --no-psqlrc --quiet --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv app_user APP_DB_USER
\getenv app_password APP_DB_PASSWORD
-- Ownership changes lock each table briefly; give up rather than queue
-- behind a long transaction on a live instance.
SET lock_timeout = '10s';
SELECT format('CREATE ROLE %I', :'app_user')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L',
              :'app_user', :'app_password') \gexec
SELECT format('ALTER DATABASE %I OWNER TO %I', current_database(), :'app_user') \gexec
SELECT format('ALTER SCHEMA public OWNER TO %I', :'app_user') \gexec
-- Indexes and the sequences behind serial columns follow their table.
SELECT format('ALTER TABLE public.%I OWNER TO %I', tablename, :'app_user')
FROM pg_tables WHERE schemaname = 'public' \gexec
SQL
