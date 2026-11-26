-- =====================================================================
-- Fingertip Auto — migration 6: book autos on the shops WhatsApp number
-- (owner, 26 Nov 2026: "Without bot support, there is no fun in trying
-- app" → chose "Same number"). The bot (smooth-responder v15) books with
-- the *_svc functions; this adds:
--   * auto_wa_book_svc: a WhatsApp booking that uses the passenger's
--     permanent PIN when that phone is also an app passenger.
--   * auto_wa_due_svc: rides booked on WhatsApp whose news the passenger
--     has not been told yet (driver coming, trip started, done, no auto,
--     cancelled by the driver side). Each is returned once.
--   * a 5-second timer that wakes the bot only when there is news
--     (URL + secret from Supabase Vault: fingertip_bot_url, fingertip_bot_secret; the secret is
--     made here from random bytes and never shown — the bot checks it with auto_wa_key_ok).
-- Rides only — nothing medicine-related. Additive: 1 column, 5 functions, 2 Vault entries, 1 timer.
-- =====================================================================

alter table public.ride_requests add column if not exists wa_told text;

create or replace function public.auto_wa_book_svc(p_phone text, p_transcript text, p_destination text)
returns public.ride_requests
language plpgsql security definer set search_path = public, extensions as $$
declare r ride_requests; pa auto_passengers;
begin
  r := create_ride_svc(p_phone, p_transcript, p_destination);
  select * into pa from auto_passengers where phone = p_phone and active;
  if pa.id is not null then
    update ride_requests set ride_code = pa.pin, passenger_id = pa.id where id = r.id returning * into r;
  end if;
  return r;
end $$;

-- What happened to a WhatsApp ride that the passenger should hear about now.
create or replace function public.auto_wa_event(r public.ride_requests)
returns text language sql immutable as $$
  select case
    when r.status = 'CONFIRMED' and r.started_at is null then 'CONFIRMED'
    when r.status = 'CONFIRMED' then 'STARTED'
    when r.status = 'COMPLETED' then 'COMPLETED'
    when r.status = 'NO_AUTO' then 'NO_AUTO'
    when r.status = 'CANCELLED' and coalesce(r.cancel_reason, '') not in ('passenger', 'superseded', 'no_location') then 'CANCELLED'
  end
$$;

-- News to send, each once. Marks it told before returning (at most once; a lost message is not re-sent).
create or replace function public.auto_wa_due_svc()
returns table (ride_id uuid, phone text, event text, ride_code text, destination_name text,
               driver_name text, driver_name_te text, auto_number text, driver_phone text)
language plpgsql security definer set search_path = public, extensions as $$
#variable_conflict use_column
begin
  return query
  with due as (
    select r.id, auto_wa_event(r) ev from ride_requests r
     where r.source = 'whatsapp' and r.created_at > now() - interval '3 hours'
       and auto_wa_event(r) is not null and auto_wa_event(r) is distinct from r.wa_told
     order by r.created_at limit 50
     for update skip locked),
  upd as (update ride_requests r set wa_told = due.ev from due where r.id = due.id returning r.*, due.ev)
  select u.id, u.passenger_phone, u.ev, u.ride_code, u.destination_name, d.name, d.name_te, d.auto_number, d.phone
    from upd u left join drivers d on d.id = u.assigned_driver_id;
end $$;

-- Timer: wake the bot only when there is news.
create or replace function public.auto_wa_kick_svc()
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare url text; secret text;
begin
  if not exists (select 1 from ride_requests r where r.source = 'whatsapp' and r.created_at > now() - interval '3 hours'
                   and auto_wa_event(r) is not null and auto_wa_event(r) is distinct from r.wa_told) then
    return false;
  end if;
  select decrypted_secret into url    from vault.decrypted_secrets where name = 'fingertip_bot_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'fingertip_bot_secret';
  if url is null or secret is null then return false; end if;
  perform net.http_post(url := url, headers := jsonb_build_object('Content-Type', 'application/json', 'x-auto-notify', secret),
                        body := '{"kind":"auto_news"}'::jsonb);
  return true;
end $$;

-- The bot checks the timer's key against Vault (service role only).
create or replace function public.auto_wa_key_ok(p_key text)
returns boolean language sql stable security definer set search_path = public, extensions as $$
  select coalesce(length(p_key) >= 32 and p_key = (select decrypted_secret from vault.decrypted_secrets where name = 'fingertip_bot_secret'), false)
$$;

-- Vault: where the bot lives, and a random key made here (never shown anywhere).
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'fingertip_bot_url') then
    perform vault.create_secret('https://fsftbvchnifshndssowe.supabase.co/functions/v1/smooth-responder', 'fingertip_bot_url', 'Fingertip WhatsApp bot (ride news)');
  end if;
  if not exists (select 1 from vault.secrets where name = 'fingertip_bot_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'fingertip_bot_secret', 'Key the ride-news timer sends to the bot');
  end if;
end $$;

revoke all on function public.auto_wa_key_ok(text) from public, anon, authenticated;
grant execute on function public.auto_wa_key_ok(text) to service_role;
revoke all on function public.auto_wa_book_svc(text, text, text) from public, anon, authenticated;
revoke all on function public.auto_wa_event(public.ride_requests) from public, anon, authenticated;
revoke all on function public.auto_wa_due_svc() from public, anon, authenticated;
revoke all on function public.auto_wa_kick_svc() from public, anon, authenticated;
grant execute on function public.auto_wa_book_svc(text, text, text) to service_role;
grant execute on function public.auto_wa_due_svc() to service_role;

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'fingertip-wa-ride-news';
  perform cron.schedule('fingertip-wa-ride-news', '5 seconds', 'select public.auto_wa_kick_svc()');
end $$;
