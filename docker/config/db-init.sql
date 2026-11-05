-- Runs once, when the database volume is created: the image's migrate.sh runs /etc/postgresql.schema.sql
-- as supabase_admin after its own migrations, with PGPASSWORD set to POSTGRES_PASSWORD from .env.
-- The same steps the Supabase CLI takes for a local stack, limited to the roles this bundle logs in with.
\set pgpass `echo "$PGPASSWORD"`

-- erp-init and backups (postgres), PostgREST (authenticator), GoTrue (supabase_auth_admin).
-- Realtime logs in as supabase_admin, whose password migrate.sh has already set.
ALTER USER postgres WITH PASSWORD :'pgpass';
ALTER USER authenticator WITH PASSWORD :'pgpass';
ALTER USER supabase_auth_admin WITH PASSWORD :'pgpass';

-- Realtime keeps its own tables here.
create schema if not exists _realtime;
alter schema _realtime owner to postgres;
