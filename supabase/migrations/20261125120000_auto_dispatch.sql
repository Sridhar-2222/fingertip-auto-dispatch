-- =====================================================================
-- Fingertip Auto Dispatch — Week 1 schema
-- WhatsApp +91 78424 49808 → voice/location → nearest autos within 3 km
--
-- REVIEW BEFORE RUNNING. This file creates new tables and functions
-- only; it does not alter or drop anything that already exists.
--
-- Design notes
--  * All state changes go through SECURITY DEFINER functions so the
--    rules (one ride per driver, first accept wins, 30 s window) live
--    in one place and run in a single transaction each.
--  * The webhook server calls the *_svc functions with the service
--    role. The driver app calls the *_self functions with the driver's
--    own login (auth.uid()). Passengers never log in: they use a long
--    random link token, never the 4-digit display code.
--  * Nothing medicine-related is stored or sent here. Rides only.
-- =====================================================================

create schema if not exists extensions;
create extension if not exists postgis  with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- Tunables (one row). Change here, not in code.
-- ---------------------------------------------------------------------
create table public.dispatch_settings (
  id                     boolean primary key default true check (id),
  search_radius_m        integer  not null default 3000,
  gps_fresh_seconds      integer  not null default 180,   -- 3 min (heartbeat is 60 s)
  search_window_seconds  integer  not null default 30,    -- beep + timeout + expiry, one number
  max_drivers_pinged     integer  not null default 5,
  location_wait_minutes  integer  not null default 15,    -- AWAITING_LOCATION auto-cancel
  read_fallback_seconds  integer  not null default 20     -- call if WhatsApp not read by then
);
insert into public.dispatch_settings default values;

-- ---------------------------------------------------------------------
-- Drivers
-- ---------------------------------------------------------------------
create table public.drivers (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid unique,                 -- auth.users.id once the driver logs into the app
  name            text not null,
  name_te         text,
  phone           text not null unique check (phone ~ '^91[6-9][0-9]{9}$'),
  auto_number     text not null,
  home_stand      text,
  route_corridor  text,
  status          text not null default 'OFFLINE'
                  check (status in ('OFFLINE','AVAILABLE','BUSY')),
  last_location   extensions.geography(Point, 4326),
  last_ping_at    timestamptz,
  push_token      text,                        -- FCM token from the Android app
  active          boolean not null default true, -- false = removed from the pilot
  created_at      timestamptz not null default now()
);
create index drivers_location_gix on public.drivers using gist (last_location);
create index drivers_dispatch_idx on public.drivers (status, last_ping_at) where active;

-- ---------------------------------------------------------------------
-- Ride requests (no passenger signup; phone comes from WhatsApp wa_id)
-- ---------------------------------------------------------------------
create table public.ride_requests (
  id                  uuid primary key default gen_random_uuid(),
  ride_code           text not null,           -- 4 digits, for reading aloud only — NOT access
  access_token        text not null unique
                      default encode(extensions.gen_random_bytes(18), 'hex'),
  passenger_phone     text not null,
  raw_transcript      text,
  destination_name    text,                    -- normalized landmark key, null if not understood
  pickup_location     extensions.geography(Point, 4326),
  status              text not null default 'AWAITING_LOCATION'
                      check (status in ('AWAITING_LOCATION','SEARCHING','CONFIRMED',
                                        'NO_AUTO','COMPLETED','CANCELLED')),
  assigned_driver_id  uuid references public.drivers(id),
  cancel_reason       text,
  created_at          timestamptz not null default now(),
  search_started_at   timestamptz,
  expires_at          timestamptz,
  confirmed_at        timestamptz,
  closed_at           timestamptz,             -- completed / cancelled / no_auto
  notify_wamid        text,                    -- WhatsApp message id of the outcome message
  notify_read_at      timestamptz,
  fallback_call_at    timestamptz
);
create index ride_requests_open_idx   on public.ride_requests (status, expires_at)
  where status in ('AWAITING_LOCATION','SEARCHING','CONFIRMED');
create index ride_requests_phone_idx  on public.ride_requests (passenger_phone, created_at desc);
create index ride_requests_wamid_idx  on public.ride_requests (notify_wamid) where notify_wamid is not null;
-- A driver can hold at most one live ride, enforced by the database too
create unique index ride_requests_one_live_per_driver
  on public.ride_requests (assigned_driver_id) where status = 'CONFIRMED';

-- ---------------------------------------------------------------------
-- Driver pings (beep log). Realtime pushes INSERTs to the driver app.
-- Carries only what the alert needs — no passenger phone or exact pin.
-- ---------------------------------------------------------------------
create table public.driver_pings (
  id                uuid primary key default gen_random_uuid(),
  ride_id           uuid not null references public.ride_requests(id) on delete cascade,
  driver_id         uuid not null references public.drivers(id),
  distance_km       numeric(5,2) not null,
  destination_name  text,
  expires_at        timestamptz not null,
  ping_status       text not null default 'SENT'
                    check (ping_status in ('SENT','ACCEPTED','DECLINED','TIMEOUT','TAKEN')),
  pinged_at         timestamptz not null default now(),
  responded_at      timestamptz,
  unique (ride_id, driver_id)
);
create index driver_pings_driver_idx on public.driver_pings (driver_id, pinged_at desc);

-- ---------------------------------------------------------------------
-- Inbound WhatsApp message de-duplication (Meta retries webhooks)
-- ---------------------------------------------------------------------
create table public.processed_messages (
  wamid        text primary key,
  received_at  timestamptz not null default now()
);

-- =====================================================================
-- Functions — webhook server (service role)
-- =====================================================================

-- New ride from a voice note / typed message. Any older ride from the
-- same phone still waiting for a location is replaced.
create or replace function public.create_ride_svc(
  p_passenger_phone text,
  p_transcript      text,
  p_destination     text
) returns public.ride_requests
language plpgsql security definer set search_path = public, extensions as $$
declare r public.ride_requests;
begin
  update ride_requests
     set status = 'CANCELLED', cancel_reason = 'superseded', closed_at = now()
   where passenger_phone = p_passenger_phone and status = 'AWAITING_LOCATION';

  insert into ride_requests (ride_code, passenger_phone, raw_transcript, destination_name)
  values (lpad((floor(random() * 10000))::int::text, 4, '0'),
          p_passenger_phone, p_transcript, p_destination)
  returning * into r;
  return r;
end $$;

-- Set / change the destination of a waiting ride (landmark button reply)
create or replace function public.set_destination_svc(p_ride_id uuid, p_destination text)
returns public.ride_requests
language plpgsql security definer set search_path = public, extensions as $$
declare r public.ride_requests;
begin
  update ride_requests
     set destination_name = p_destination
   where id = p_ride_id and status = 'AWAITING_LOCATION'
  returning * into r;
  return r;
end $$;

-- The passenger's latest ride still waiting for a location pin
create or replace function public.awaiting_ride_svc(p_passenger_phone text)
returns public.ride_requests
language sql stable security definer set search_path = public, extensions as $$
  select * from ride_requests
   where passenger_phone = p_passenger_phone and status = 'AWAITING_LOCATION'
     and created_at > now() - make_interval(mins => (select location_wait_minutes from dispatch_settings))
   order by created_at desc limit 1
$$;

-- The passenger's ride that is already searching or confirmed (last 30 min),
-- so a second location pin doesn't start a second search
create or replace function public.open_ride_svc(p_passenger_phone text)
returns public.ride_requests
language sql stable security definer set search_path = public, extensions as $$
  select * from ride_requests
   where passenger_phone = p_passenger_phone and status in ('SEARCHING','CONFIRMED')
     and created_at > now() - interval '30 minutes'
   order by created_at desc limit 1
$$;

-- Location pin arrived: save it, find drivers, write pings — one transaction.
-- Returns the drivers that were pinged (empty set ⇒ ride is now NO_AUTO).
create or replace function public.start_search_svc(p_ride_id uuid, p_lat double precision, p_lng double precision)
returns table (driver_id uuid, driver_name text, driver_phone text, push_token text, distance_km numeric)
language plpgsql security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare
  s   dispatch_settings;
  r   ride_requests;
  pt  geography := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;
  n   integer;
begin
  select * into s from dispatch_settings;
  select * into r from ride_requests where id = p_ride_id for update;
  if r.id is null or r.status <> 'AWAITING_LOCATION' then
    return;  -- already searching / closed: do nothing (webhook retry safe)
  end if;

  update ride_requests
     set pickup_location   = pt,
         status            = 'SEARCHING',
         search_started_at = now(),
         expires_at        = now() + make_interval(secs => s.search_window_seconds)
   where id = p_ride_id
  returning * into r;

  insert into driver_pings (ride_id, driver_id, distance_km, destination_name, expires_at)
  select r.id, d.id, round((ST_Distance(d.last_location, pt) / 1000)::numeric, 2),
         r.destination_name, r.expires_at
    from drivers d
   where d.active
     and d.status = 'AVAILABLE'
     and d.last_ping_at > now() - make_interval(secs => s.gps_fresh_seconds)
     and ST_DWithin(d.last_location, pt, s.search_radius_m)
   order by ST_Distance(d.last_location, pt)
   limit s.max_drivers_pinged;

  get diagnostics n = row_count;
  if n = 0 then
    update ride_requests set status = 'NO_AUTO', closed_at = now(), cancel_reason = 'no_driver_in_radius'
     where id = p_ride_id;
    return;
  end if;

  return query
    select d.id, d.name, d.phone, d.push_token, p.distance_km
      from driver_pings p join drivers d on d.id = p.driver_id
     where p.ride_id = p_ride_id
     order by p.distance_km;
end $$;

-- First accept wins. Locks the ride row, so concurrent accepts queue up
-- and every one after the first sees status <> SEARCHING.
-- Also refuses a driver who is already BUSY (no double-booking).
-- Returns { ok, reason, ride_id, passenger_phone, pickup_lat, pickup_lng,
--           driver{...}, other_driver_ids[] }
create or replace function public.accept_ride_svc(p_ride_id uuid, p_driver_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  r  ride_requests;
  d  drivers;
  others uuid[];
begin
  select * into r from ride_requests where id = p_ride_id for update;
  if r.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if not exists (select 1 from driver_pings where ride_id = p_ride_id and driver_id = p_driver_id) then
    return jsonb_build_object('ok', false, 'reason', 'not_pinged');
  end if;
  if r.status <> 'SEARCHING' then
    return jsonb_build_object('ok', false, 'reason', 'taken');
  end if;
  if r.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;

  update drivers set status = 'BUSY'
   where id = p_driver_id and status = 'AVAILABLE' and active
  returning * into d;
  if d.id is null then
    return jsonb_build_object('ok', false, 'reason', 'driver_not_available');
  end if;

  update ride_requests
     set status = 'CONFIRMED', assigned_driver_id = p_driver_id, confirmed_at = now()
   where id = p_ride_id
  returning * into r;

  update driver_pings set ping_status = 'ACCEPTED', responded_at = now()
   where ride_id = p_ride_id and driver_id = p_driver_id;

  with t as (
    update driver_pings set ping_status = 'TAKEN', responded_at = now()
     where ride_id = p_ride_id and driver_id <> p_driver_id and ping_status = 'SENT'
    returning driver_id)
  select coalesce(array_agg(driver_id), '{}') into others from t;

  return jsonb_build_object(
    'ok', true,
    'ride_id', r.id,
    'ride_code', r.ride_code,
    'access_token', r.access_token,
    'passenger_phone', r.passenger_phone,
    'destination_name', r.destination_name,
    'pickup_lat', ST_Y(r.pickup_location::geometry),
    'pickup_lng', ST_X(r.pickup_location::geometry),
    'driver', jsonb_build_object('id', d.id, 'name', d.name, 'name_te', d.name_te,
                                 'phone', d.phone, 'auto_number', d.auto_number),
    'other_driver_ids', to_jsonb(others));
end $$;

-- Driver taps SKIP. If every pinged driver has said no, close the ride now
-- instead of waiting out the timer. Returns { all_declined, passenger_phone }.
create or replace function public.decline_ride_svc(p_ride_id uuid, p_driver_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r ride_requests; open_pings int;
begin
  select * into r from ride_requests where id = p_ride_id for update;
  if r.id is null then return jsonb_build_object('all_declined', false); end if;

  update driver_pings set ping_status = 'DECLINED', responded_at = now()
   where ride_id = p_ride_id and driver_id = p_driver_id and ping_status = 'SENT';

  select count(*) into open_pings from driver_pings where ride_id = p_ride_id and ping_status = 'SENT';
  if r.status = 'SEARCHING' and open_pings = 0 then
    update ride_requests set status = 'NO_AUTO', closed_at = now(), cancel_reason = 'all_declined'
     where id = p_ride_id;
    return jsonb_build_object('all_declined', true, 'ride_id', r.id, 'passenger_phone', r.passenger_phone);
  end if;
  return jsonb_build_object('all_declined', false);
end $$;

-- Called by the server's worker every ~2 s. Closes SEARCHING rides whose
-- window has passed and returns them so the passenger can be told.
-- Also quietly cancels rides that never got a location pin.
create or replace function public.expire_due_rides_svc()
returns table (ride_id uuid, passenger_phone text, timed_out_driver_ids uuid[])
language plpgsql security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare s dispatch_settings;
begin
  select * into s from dispatch_settings;

  update ride_requests
     set status = 'CANCELLED', cancel_reason = 'no_location', closed_at = now()
   where status = 'AWAITING_LOCATION'
     and created_at < now() - make_interval(mins => s.location_wait_minutes);

  return query
  with due as (
    select r.id from ride_requests r
     where r.status = 'SEARCHING' and r.expires_at <= now()
     for update skip locked),
  closed as (
    update ride_requests r
       set status = 'NO_AUTO', closed_at = now(), cancel_reason = 'timeout'
      from due where r.id = due.id
    returning r.id, r.passenger_phone),
  pings as (
    update driver_pings p set ping_status = 'TIMEOUT', responded_at = now()
      from closed where p.ride_id = closed.id and p.ping_status = 'SENT'
    returning p.ride_id, p.driver_id)
  select c.id, c.passenger_phone,
         coalesce((select array_agg(pp.driver_id) from pings pp where pp.ride_id = c.id), '{}')
    from closed c;
end $$;

-- Remember which WhatsApp message told the passenger the outcome
create or replace function public.set_notify_wamid_svc(p_ride_id uuid, p_wamid text)
returns void language sql security definer set search_path = public, extensions as $$
  update ride_requests set notify_wamid = p_wamid where id = p_ride_id
$$;

-- WhatsApp status webhook: message was read
create or replace function public.mark_notify_read_svc(p_wamid text)
returns void language sql security definer set search_path = public, extensions as $$
  update ride_requests set notify_read_at = coalesce(notify_read_at, now())
   where notify_wamid = p_wamid
$$;

-- Confirmed rides whose WhatsApp message wasn't read in time → phone call.
-- Claims them (sets fallback_call_at) so each gets at most one call.
create or replace function public.claim_fallback_calls_svc()
returns table (ride_id uuid, passenger_phone text, status text)
language sql security definer set search_path = public, extensions as $$
  update ride_requests r
     set fallback_call_at = now()
   where r.fallback_call_at is null
     and r.notify_read_at is null
     and r.notify_wamid is not null
     and r.status in ('CONFIRMED','NO_AUTO')
     and coalesce(r.confirmed_at, r.closed_at)
         < now() - make_interval(secs => (select read_fallback_seconds from dispatch_settings))
     and coalesce(r.confirmed_at, r.closed_at) > now() - interval '5 minutes'
  returning r.id, r.passenger_phone, r.status
$$;

-- Inbound message de-dup: true the first time a wamid is seen
create or replace function public.claim_message_svc(p_wamid text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
begin
  insert into processed_messages (wamid) values (p_wamid);
  return true;
exception when unique_violation then
  return false;
end $$;

-- Driver finished the trip
create or replace function public.complete_ride_svc(p_ride_id uuid, p_driver_id uuid)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare r ride_requests;
begin
  update ride_requests set status = 'COMPLETED', closed_at = now()
   where id = p_ride_id and assigned_driver_id = p_driver_id and status = 'CONFIRMED'
  returning * into r;
  if r.id is null then return false; end if;
  update drivers set status = 'AVAILABLE' where id = p_driver_id and status = 'BUSY';
  return true;
end $$;

-- Passenger cancels from the link (token) — frees the driver if one was assigned.
-- Returns { ok, driver_id, driver_phone }.
create or replace function public.cancel_ride_by_token_svc(p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r ride_requests; d drivers;
begin
  select * into r from ride_requests where access_token = p_token for update;
  if r.id is null or r.status not in ('AWAITING_LOCATION','SEARCHING','CONFIRMED') then
    return jsonb_build_object('ok', false);
  end if;
  update ride_requests set status = 'CANCELLED', cancel_reason = 'passenger', closed_at = now()
   where id = r.id;
  update driver_pings set ping_status = 'TIMEOUT', responded_at = now()
   where ride_id = r.id and ping_status = 'SENT';
  if r.assigned_driver_id is not null then
    update drivers set status = 'AVAILABLE' where id = r.assigned_driver_id and status = 'BUSY'
    returning * into d;
  end if;
  return jsonb_build_object('ok', true, 'ride_id', r.id,
                            'driver_id', r.assigned_driver_id, 'driver_phone', d.phone);
end $$;

-- Look up a driver by their app login (used by the server to authorise driver API calls)
create or replace function public.driver_by_user_svc(p_user_id uuid)
returns public.drivers language sql stable security definer set search_path = public, extensions as $$
  select * from drivers where user_id = p_user_id and active
$$;

-- =====================================================================
-- Functions — passenger link (anon, token only)
-- =====================================================================
create or replace function public.ride_status_by_token(p_token text)
returns jsonb language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object(
           'ride_code', r.ride_code,
           'status', r.status,
           'destination_name', r.destination_name,
           'expires_at', r.expires_at,
           'drivers_pinged', (select count(*) from driver_pings p where p.ride_id = r.id),
           'driver', case when r.status = 'CONFIRMED' then jsonb_build_object(
                        'name', d.name, 'name_te', d.name_te,
                        'auto_number', d.auto_number, 'phone', d.phone,
                        'lat', ST_Y(d.last_location::geometry),
                        'lng', ST_X(d.last_location::geometry)) end)
    from ride_requests r left join drivers d on d.id = r.assigned_driver_id
   where r.access_token = p_token
     and length(p_token) >= 32
     and r.created_at > now() - interval '24 hours'
$$;

-- =====================================================================
-- Functions — driver app (authenticated driver, auth.uid())
-- =====================================================================
create or replace function public.driver_heartbeat_self(p_lat double precision, p_lng double precision)
returns void language sql security definer set search_path = public, extensions as $$
  update drivers
     set last_location = ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
         last_ping_at  = now()
   where user_id = auth.uid() and active
$$;

-- ON DUTY / OFF DUTY toggle. Can't go off duty mid-ride.
create or replace function public.set_duty_self(p_on boolean)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare new_status text;
begin
  update drivers
     set status = case when p_on then 'AVAILABLE' else 'OFFLINE' end
   where user_id = auth.uid() and active and status <> 'BUSY'
  returning status into new_status;
  return coalesce(new_status, (select status from drivers where user_id = auth.uid()));
end $$;

-- The driver's current confirmed ride, with the passenger's pin and phone
create or replace function public.driver_current_ride_self()
returns jsonb language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object(
           'ride_id', r.id, 'ride_code', r.ride_code,
           'passenger_phone', r.passenger_phone,
           'destination_name', r.destination_name,
           'pickup_lat', ST_Y(r.pickup_location::geometry),
           'pickup_lng', ST_X(r.pickup_location::geometry))
    from ride_requests r join drivers d on d.id = r.assigned_driver_id
   where d.user_id = auth.uid() and r.status = 'CONFIRMED'
$$;

-- =====================================================================
-- Row level security: nothing is readable by default.
-- Drivers may read their own row and their own pings (for Realtime).
-- =====================================================================
alter table public.dispatch_settings  enable row level security;
alter table public.drivers            enable row level security;
alter table public.ride_requests      enable row level security;
alter table public.driver_pings       enable row level security;
alter table public.processed_messages enable row level security;

create policy drivers_read_own on public.drivers
  for select to authenticated using (user_id = auth.uid());

create policy pings_read_own on public.driver_pings
  for select to authenticated
  using (driver_id in (select id from public.drivers where user_id = auth.uid()));

-- Lock every function down, then grant exactly what each caller needs
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('create_ride_svc','set_destination_svc','awaiting_ride_svc','open_ride_svc','start_search_svc',
                         'accept_ride_svc','decline_ride_svc','expire_due_rides_svc','set_notify_wamid_svc',
                         'mark_notify_read_svc','claim_fallback_calls_svc','claim_message_svc',
                         'complete_ride_svc','cancel_ride_by_token_svc','driver_by_user_svc',
                         'ride_status_by_token','driver_heartbeat_self','set_duty_self',
                         'driver_current_ride_self')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

grant execute on function public.ride_status_by_token(text) to anon, authenticated;
grant execute on function public.driver_heartbeat_self(double precision, double precision) to authenticated;
grant execute on function public.set_duty_self(boolean) to authenticated;
grant execute on function public.driver_current_ride_self() to authenticated;
-- *_svc functions: service_role only (Supabase grants it everything by default;
-- the webhook server connects as service_role / postgres).

-- Realtime: driver app listens for INSERTs on its own pings
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.driver_pings;
  end if;
end $$;

