-- Minimal stand-in for what a Supabase project provides, so domain tests can run on a throwaway
-- database. PostgREST and GoTrue behaviour itself is covered by test/*.e2e.mjs on the real stack.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;
create schema if not exists extensions;
create extension if not exists pgcrypto schema extensions;
create schema if not exists auth;
create table if not exists auth.users (
  instance_id uuid, id uuid primary key, aud text, role text, email text, encrypted_password text,
  email_confirmed_at timestamptz, raw_app_meta_data jsonb, raw_user_meta_data jsonb,
  created_at timestamptz, updated_at timestamptz, confirmation_token text, email_change text,
  email_change_token_new text, recovery_token text
);
create table if not exists auth.identities (
  provider_id text, user_id uuid, identity_data jsonb, provider text, last_sign_in_at timestamptz,
  created_at timestamptz, updated_at timestamptz
);
grant usage on schema public to anon, authenticated, service_role;
