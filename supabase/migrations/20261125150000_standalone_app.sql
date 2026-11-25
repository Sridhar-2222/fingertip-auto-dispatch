-- =====================================================================
-- Fingertip Auto Dispatch — migration 2: driver Android app + WhatsApp bot
-- on Supabase alone (no paid server).
-- Run AFTER 20261125120000_auto_dispatch.sql. Additive only.
--
-- Adds:
--  * Driver pairing codes: you add a driver in the Table Editor, a 6-digit
--    code is made for them; they type phone + code once in the driver app.
--    No SMS, no cost. 5 wrong codes locks that driver until you reset it.
--  * Driver actions from the app: accept / skip / trip done.
--  * Passenger cancels by replying రద్దు / CANCEL on WhatsApp.
--  * Supabase Cron job: closes rides nobody accepted, every 5 seconds, and
--    asks the Edge Function to tell the passenger — only when a ride closes,
--    so the free plan's function quota is not used up by the timer.
-- REVIEW BEFORE RUNNING.
-- =====================================================================

alter table public.drivers
  add column if not exists pair_code  text default lpad((floor(random() * 1000000))::int::text, 6, '0'),
  add column if not exists pair_fails integer not null default 0;

-- Codes for drivers created before this migration
update public.drivers set pair_code = lpad((floor(random() * 1000000))::int::text, 6, '0')
 where pair_code is null and user_id is null;

-- ---------------------------------------------------------------------
-- Driver: pair this phone (anonymous Supabase login) with a driver row
-- ---------------------------------------------------------------------
create or replace function public.claim_driver_self(p_phone text, p_code text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  uid   uuid := auth.uid();
  ph    text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  d     drivers;
begin
  if uid is null then return jsonb_build_object('ok', false, 'reason', 'not_signed_in'); end if;
  if length(ph) = 10 then ph := '91' || ph; end if;

  select * into d from drivers where phone = ph and active for update;
  if d.id is null then return jsonb_build_object('ok', false, 'reason', 'unknown_phone'); end if;
  if d.pair_fails >= 5 then return jsonb_build_object('ok', false, 'reason', 'locked'); end if;
  if d.pair_code is null or d.pair_code <> coalesce(p_code, '') then
    update drivers set pair_fails = pair_fails + 1 where id = d.id;
    return jsonb_build_object('ok', false, 'reason', 'wrong_code');
  end if;

  update drivers set user_id = null where user_id = uid and id <> d.id;   -- one phone = one driver
  update drivers set user_id = uid, pair_code = null, pair_fails = 0 where id = d.id;
  return jsonb_build_object('ok', true, 'driver_id', d.id, 'name', d.name);
end $$;

-- Driver's own profile (no pairing code)
create or replace function public.driver_me_self()
returns jsonb language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object(
           'id', d.id, 'name', d.name, 'name_te', d.name_te, 'phone', d.phone,
           'auto_number', d.auto_number, 'status', d.status, 'last_ping_at', d.last_ping_at,
           'lat', ST_Y(d.last_location::geometry), 'lng', ST_X(d.last_location::geometry))
    from drivers d where d.user_id = auth.uid() and d.active
$$;

-- The newest ride alert still waiting for this driver's answer.
-- The app checks this every few seconds as a backup to Realtime, which
-- Android may pause while the phone is in a pocket.
create or replace function public.driver_open_ping_self()
returns jsonb language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object('ride_id', p.ride_id, 'distance_km', p.distance_km,
                            'destination_name', p.destination_name, 'expires_at', p.expires_at)
    from driver_pings p join drivers d on d.id = p.driver_id
   where d.user_id = auth.uid() and p.ping_status = 'SENT' and p.expires_at > now()
   order by p.pinged_at desc limit 1
$$;

-- Driver taps ACCEPT. First accept wins (rules in accept_ride_svc).
-- The winner gets the passenger's phone + pickup pin; never the passenger's link token.
create or replace function public.accept_ride_self(p_ride_id uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare did uuid; r jsonb;
begin
  select id into did from drivers where user_id = auth.uid() and active;
  if did is null then return jsonb_build_object('ok', false, 'reason', 'not_paired'); end if;
  r := accept_ride_svc(p_ride_id, did);
  return r - 'access_token' - 'other_driver_ids';
end $$;

create or replace function public.decline_ride_self(p_ride_id uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare did uuid;
begin
  select id into did from drivers where user_id = auth.uid() and active;
  if did is null then return jsonb_build_object('ok', false); end if;
  perform decline_ride_svc(p_ride_id, did);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.complete_ride_self(p_ride_id uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare did uuid;
begin
  select id into did from drivers where user_id = auth.uid() and active;
  if did is null then return jsonb_build_object('ok', false); end if;
  return jsonb_build_object('ok', complete_ride_svc(p_ride_id, did));
end $$;

-- ---------------------------------------------------------------------
-- Passenger replies "రద్దు" / "cancel" on WhatsApp → cancel their live ride.
-- Returns { ok, ride_id, driver_id, driver_phone }.
-- ---------------------------------------------------------------------
create or replace function public.cancel_by_phone_svc(p_passenger_phone text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare tok text;
begin
  select access_token into tok from ride_requests
   where passenger_phone = p_passenger_phone
     and status in ('AWAITING_LOCATION','SEARCHING','CONFIRMED')
     and created_at > now() - interval '2 hours'
   order by created_at desc limit 1;
  if tok is null then return jsonb_build_object('ok', false); end if;
  return cancel_ride_by_token_svc(tok);
end $$;

-- ---------------------------------------------------------------------
-- Timer job body: close expired searches, then ask the Edge Function to
-- message each passenger. Reads the function URL and a shared secret from
-- Supabase Vault (you create both; see SETUP.md). Without them it still
-- closes rides, it just can't send the WhatsApp message.
-- ---------------------------------------------------------------------
create or replace function public.expire_and_notify_svc()
returns integer language plpgsql security definer set search_path = public, extensions as $$
declare
  r record; url text; secret text; n integer := 0;
begin
  for r in select * from expire_due_rides_svc() loop
    if url is null then
      select decrypted_secret into url    from vault.decrypted_secrets where name = 'fingertip_function_url';
      select decrypted_secret into secret from vault.decrypted_secrets where name = 'fingertip_cron_secret';
    end if;
    if url is not null and secret is not null then
      perform net.http_post(
        url     := url || '/notify',
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', secret),
        body    := jsonb_build_object('kind', 'NO_AUTO', 'ride_id', r.ride_id,
                                      'passenger_phone', r.passenger_phone,
                                      'timed_out_driver_ids', to_jsonb(r.timed_out_driver_ids)));
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
revoke all on function public.claim_driver_self(text, text)         from public, anon, authenticated;
revoke all on function public.driver_me_self()                       from public, anon, authenticated;
revoke all on function public.driver_open_ping_self()                from public, anon, authenticated;
revoke all on function public.accept_ride_self(uuid)                 from public, anon, authenticated;
revoke all on function public.decline_ride_self(uuid)                from public, anon, authenticated;
revoke all on function public.complete_ride_self(uuid)               from public, anon, authenticated;
revoke all on function public.cancel_by_phone_svc(text)             from public, anon, authenticated;
revoke all on function public.expire_and_notify_svc()                from public, anon, authenticated;

grant execute on function public.claim_driver_self(text, text) to authenticated;
grant execute on function public.driver_me_self()               to authenticated;
grant execute on function public.driver_open_ping_self()        to authenticated;
grant execute on function public.accept_ride_self(uuid)         to authenticated;
grant execute on function public.decline_ride_self(uuid)        to authenticated;
grant execute on function public.complete_ride_self(uuid)       to authenticated;

-- Pairing codes must never be readable through the table. Supabase grants
-- whole-table access by default, so swap it for named columns only
-- (row level security still limits drivers to their own row).
revoke select, insert, update, delete on public.drivers from anon, authenticated;
grant select (id, user_id, name, name_te, auto_number, status) on public.drivers to authenticated;

-- ---------------------------------------------------------------------
-- Supabase Cron: close rides nobody accepted (every 5 seconds) and notify
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    create extension if not exists pg_net;
    perform cron.unschedule(jobid) from cron.job where jobname = 'fingertip-expire-rides';
    perform cron.schedule('fingertip-expire-rides', '5 seconds', 'select public.expire_and_notify_svc()');
    -- keep the job log small
    perform cron.unschedule(jobid) from cron.job where jobname = 'fingertip-cron-log-cleanup';
    perform cron.schedule('fingertip-cron-log-cleanup', '0 3 * * *',
      $q$delete from cron.job_run_details where end_time < now() - interval '2 days'$q$);
  else
    raise notice 'pg_cron not available here — enable "pg_cron" under Database → Extensions, then re-run this block';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- The Edge Function calls the *_svc functions with the service role.
-- Supabase normally grants this already; make it explicit.
-- ---------------------------------------------------------------------
do $$
declare f record;
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    for f in select p.oid::regprocedure as sig from pg_proc p
              where p.pronamespace = 'public'::regnamespace and p.proname like '%\_svc' escape '\'
    loop
      execute format('grant execute on function %s to service_role', f.sig);
    end loop;
  end if;
end $$;
