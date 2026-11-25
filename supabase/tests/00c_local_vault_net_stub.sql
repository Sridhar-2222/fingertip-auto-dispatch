-- LOCAL TESTING ONLY. Stand-ins for Supabase Vault and pg_net so the
-- timer job can be tested; on Supabase these already exist.
create schema if not exists vault;
create table if not exists vault.secrets_store (name text primary key, decrypted_secret text);
create or replace view vault.decrypted_secrets as select name, decrypted_secret from vault.secrets_store;
create schema if not exists net;
create table if not exists net.calls (id serial, url text, headers jsonb, body jsonb);
create or replace function net.http_post(url text, headers jsonb, body jsonb) returns bigint
language sql as $$ insert into net.calls (url, headers, body) values (url, headers, body) returning id::bigint $$;
