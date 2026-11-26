-- =====================================================================
-- Fingertip Auto — migration 3: phase 1 app (driver + passenger) with
-- NO anonymous sign-in (owner decision 25 Nov 2026).
--
-- How sign-in works:
--  * The owner adds a driver (table drivers) or a passenger (table
--    auto_passengers) in the Supabase Table Editor. A 6-digit pair_code
--    is made automatically.
--  * The person types phone + code once in the app. auto_pair() checks it
--    and returns a long random device key, shown once and kept only on the
--    phone. The database keeps just its SHA-256 hash.
--  * Every other call sends that key. The functions below look up the
--    device from the hash; nothing else is readable by visitors.
--  * 5 wrong codes lock that phone number until the owner resets pair_fails.
-- Additive only, plus one fix in accept_ride_svc (late accept now says
-- "expired" / "cancelled" instead of "taken").
-- =====================================================================

-- ---------------------------------------------------------------------
-- Passengers who use the app (WhatsApp passengers need no row here)
-- ---------------------------------------------------------------------
create table if not exists public.auto_passengers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  phone       text not null unique check (phone ~ '^91[6-9][0-9]{9}$'),
  pair_code   text default lpad((floor(random() * 1000000))::int::text, 6, '0'),
  pair_fails  integer not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- One row per paired phone. Only the hash of the key is stored.
create table if not exists public.auto_devices (
  id            uuid primary key default gen_random_uuid(),
  key_hash      text not null unique,
  role          text not null check (role in ('driver', 'passenger')),
  driver_id     uuid references public.drivers(id) on delete cascade,
  passenger_id  uuid references public.auto_passengers(id) on delete cascade,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  check ((role = 'driver' and driver_id is not null and passenger_id is null)
      or (role = 'passenger' and passenger_id is not null and driver_id is null))
);
create index if not exists auto_devices_driver_idx on public.auto_devices (driver_id);
create index if not exists auto_devices_passenger_idx on public.auto_devices (passenger_id);

-- Rides booked from the app remember the passenger and where they came from
alter table public.ride_requests
  add column if not exists passenger_id uuid references public.auto_passengers(id),
  add column if not exists source text not null default 'whatsapp';
alter table public.ride_requests drop constraint if exists ride_requests_source_check;
alter table public.ride_requests add constraint ride_requests_source_check check (source in ('whatsapp', 'app'));

alter table public.auto_passengers enable row level security;
alter table public.auto_devices    enable row level security;
revoke all on public.auto_passengers, public.auto_devices from anon, authenticated;

-- ---------------------------------------------------------------------
-- Late accept: tell the driver the real reason
-- ---------------------------------------------------------------------
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
    return jsonb_build_object('ok', false, 'reason',
      case r.status when 'CONFIRMED' then 'taken' when 'COMPLETED' then 'taken'
                    when 'CANCELLED' then 'cancelled' else 'expired' end);
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

-- ---------------------------------------------------------------------
-- Internal: find the device for a key (not callable from outside)
-- ---------------------------------------------------------------------
create or replace function public.auto_device_svc(p_key text)
returns public.auto_devices
language plpgsql security definer set search_path = public, extensions as $$
declare dv auto_devices;
begin
  if p_key is null or length(p_key) < 40 then return null; end if;
  update auto_devices set last_seen_at = now()
   where key_hash = encode(extensions.digest(p_key, 'sha256'), 'hex')
  returning * into dv;
  if dv.id is null then return null; end if;
  if dv.role = 'driver' and not exists (select 1 from drivers where id = dv.driver_id and active) then return null; end if;
  if dv.role = 'passenger' and not exists (select 1 from auto_passengers where id = dv.passenger_id and active) then return null; end if;
  return dv;
end $$;

-- ---------------------------------------------------------------------
-- Pair this phone. Returns the device key once.
-- ---------------------------------------------------------------------
create or replace function public.auto_pair(p_role text, p_phone text, p_code text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  ph   text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  k    text := encode(extensions.gen_random_bytes(32), 'hex');
  d    drivers;
  pa   auto_passengers;
begin
  if length(ph) = 10 then ph := '91' || ph; end if;
  if p_role = 'driver' then
    select * into d from drivers where phone = ph and active for update;
    if d.id is null then return jsonb_build_object('ok', false, 'reason', 'unknown_phone'); end if;
    if d.pair_fails >= 5 then return jsonb_build_object('ok', false, 'reason', 'locked'); end if;
    if d.pair_code is null or d.pair_code <> coalesce(p_code, '') then
      update drivers set pair_fails = pair_fails + 1 where id = d.id;
      return jsonb_build_object('ok', false, 'reason', 'wrong_code');
    end if;
    delete from auto_devices where driver_id = d.id;            -- one phone per driver
    insert into auto_devices (key_hash, role, driver_id)
    values (encode(extensions.digest(k, 'sha256'), 'hex'), 'driver', d.id);
    update drivers set pair_code = null, pair_fails = 0 where id = d.id;
    return jsonb_build_object('ok', true, 'key', k, 'role', 'driver', 'name', d.name);
  elsif p_role = 'passenger' then
    select * into pa from auto_passengers where phone = ph and active for update;
    if pa.id is null then return jsonb_build_object('ok', false, 'reason', 'unknown_phone'); end if;
    if pa.pair_fails >= 5 then return jsonb_build_object('ok', false, 'reason', 'locked'); end if;
    if pa.pair_code is null or pa.pair_code <> coalesce(p_code, '') then
      update auto_passengers set pair_fails = pair_fails + 1 where id = pa.id;
      return jsonb_build_object('ok', false, 'reason', 'wrong_code');
    end if;
    delete from auto_devices where passenger_id = pa.id;
    insert into auto_devices (key_hash, role, passenger_id)
    values (encode(extensions.digest(k, 'sha256'), 'hex'), 'passenger', pa.id);
    update auto_passengers set pair_code = null, pair_fails = 0 where id = pa.id;
    return jsonb_build_object('ok', true, 'key', k, 'role', 'passenger', 'name', pa.name);
  end if;
  return jsonb_build_object('ok', false, 'reason', 'bad_role');
end $$;

-- ---------------------------------------------------------------------
-- Driver
-- ---------------------------------------------------------------------
create or replace function public.auto_driver_me(p_key text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare dv auto_devices := auto_device_svc(p_key);
begin
  if dv.id is null or dv.role <> 'driver' then return jsonb_build_object('ok', false, 'reason', 'not_paired'); end if;
  return (select jsonb_build_object('ok', true, 'id', d.id, 'name', d.name, 'name_te', d.name_te,
                 'auto_number', d.auto_number, 'status', d.status)
            from drivers d where d.id = dv.driver_id);
end $$;

create or replace function public.auto_driver_duty(p_key text, p_on boolean)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare dv auto_devices := auto_device_svc(p_key); st text;
begin
  if dv.id is null or dv.role <> 'driver' then return jsonb_build_object('ok', false, 'reason', 'not_paired'); end if;
  update drivers set status = case when p_on then 'AVAILABLE' else 'OFFLINE' end
   where id = dv.driver_id and status <> 'BUSY'
  returning status into st;
  return jsonb_build_object('ok', true, 'status', coalesce(st, (select status from drivers where id = dv.driver_id)));
end $$;

create or replace function public.auto_driver_beat(p_key text, p_lat double precision, p_lng double precision)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare dv auto_devices := auto_device_svc(p_key);
begin
  if dv.id is null or dv.role <> 'driver' then return jsonb_build_object('ok', false, 'reason', 'not_paired'); end if;
  if p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    return jsonb_build_object('ok', false, 'reason', 'bad_location');
  end if;
  update drivers set last_location = ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography, last_ping_at = now()
   where id = dv.driver_id;
  return jsonb_build_object('ok', true);
end $$;

-- One call every few seconds: duty status, the open alert (if any), the current ride (if any)
create or replace function public.auto_driver_poll(p_key text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare dv auto_devices := auto_device_svc(p_key);
begin
  if dv.id is null or dv.role <> 'driver' then return jsonb_build_object('ok', false, 'reason', 'not_paired'); end if;
  return jsonb_build_object(
    'ok', true,
    'status', (select status from drivers where id = dv.driver_id),
    'alert', (select jsonb_build_object('ride_id', p.ride_id, 'distance_km', p.distance_km,
                                        'destination_name', p.destination_name, 'expires_at', p.expires_at)
                from driver_pings p
               where p.driver_id = dv.driver_id and p.ping_status = 'SENT' and p.expires_at > now()
               order by p.pinged_at desc limit 1),
    'ride', (select jsonb_build_object('ride_id', r.id, 'ride_code', r.ride_code,
                                       'passenger_phone', r.passenger_phone,
                                       'destination_name', r.destination_name,
                                       'pickup_lat', ST_Y(r.pickup_location::geometry),
                                       'pickup_lng', ST_X(r.pickup_location::geometry))
               from ride_requests r
              where r.assigned_driver_id = dv.driver_id and r.status = 'CONFIRMED'
              limit 1));
end $$;

create or replace function public.auto_driver_accept(p_key text, p_ride_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare dv auto_devices := auto_device_svc(p_key);
begin
  if dv.id is null or dv.role <> 'driver' then return jsonb_build_object('ok', false, 'reason', 'not_paired'); end if;
  return accept_ride_svc(p_ride_id, dv.driver_id) - 'access_token' - 'other_driver_ids';
end $$;

create or replace function public.auto_driver_skip(p_key text, p_ride_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare dv auto_devices := auto_device_svc(p_key);
begin
  if dv.id is null or dv.role <> 'driver' then return jsonb_build_object('ok', false, 'reason', 'not_paired'); end if;
  perform decline_ride_svc(p_ride_id, dv.driver_id);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.auto_driver_done(p_key text, p_ride_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare dv auto_devices := auto_device_svc(p_key);
begin
  if dv.id is null or dv.role <> 'driver' then return jsonb_build_object('ok', false, 'reason', 'not_paired'); end if;
  return jsonb_build_object('ok', complete_ride_svc(p_ride_id, dv.driver_id));
end $$;

-- ---------------------------------------------------------------------
-- Passenger
-- ---------------------------------------------------------------------
create or replace function public.auto_passenger_me(p_key text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare dv auto_devices := auto_device_svc(p_key);
begin
  if dv.id is null or dv.role <> 'passenger' then return jsonb_build_object('ok', false, 'reason', 'not_paired'); end if;
  return (select jsonb_build_object('ok', true, 'id', p.id, 'name', p.name)
            from auto_passengers p where p.id = dv.passenger_id);
end $$;

-- Book: pickup = phone GPS, destination = spoken words (+ matched place key if any).
create or replace function public.auto_book(p_key text, p_lat double precision, p_lng double precision,
                                            p_said text, p_place text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  dv  auto_devices := auto_device_svc(p_key);
  pa  auto_passengers;
  r   ride_requests;
  n   integer;
  dest text;
begin
  if dv.id is null or dv.role <> 'passenger' then return jsonb_build_object('ok', false, 'reason', 'not_paired'); end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    return jsonb_build_object('ok', false, 'reason', 'no_location');
  end if;
  select * into pa from auto_passengers where id = dv.passenger_id;
  if exists (select 1 from ride_requests where passenger_id = pa.id
               and status in ('AWAITING_LOCATION', 'SEARCHING', 'CONFIRMED')
               and created_at > now() - interval '2 hours') then
    return jsonb_build_object('ok', false, 'reason', 'already_booked');
  end if;
  dest := nullif(left(btrim(coalesce(nullif(p_place, ''), p_said, '')), 80), '');
  if dest is null then return jsonb_build_object('ok', false, 'reason', 'no_destination'); end if;

  r := create_ride_svc(pa.phone, left(p_said, 300), dest);
  update ride_requests set passenger_id = pa.id, source = 'app' where id = r.id;
  select count(*) into n from start_search_svc(r.id, p_lat, p_lng);
  return jsonb_build_object('ok', true, 'ride_id', r.id, 'drivers_alerted', n);
end $$;

-- Passenger screen checks this every few seconds
create or replace function public.auto_passenger_poll(p_key text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare dv auto_devices := auto_device_svc(p_key); r ride_requests; d drivers;
begin
  if dv.id is null or dv.role <> 'passenger' then return jsonb_build_object('ok', false, 'reason', 'not_paired'); end if;
  select * into r from ride_requests
   where passenger_id = dv.passenger_id and created_at > now() - interval '2 hours'
   order by created_at desc limit 1;
  if r.id is null then return jsonb_build_object('ok', true, 'ride', null); end if;
  if r.assigned_driver_id is not null then select * into d from drivers where id = r.assigned_driver_id; end if;
  return jsonb_build_object('ok', true, 'ride', jsonb_build_object(
    'ride_id', r.id, 'ride_code', r.ride_code, 'status', r.status, 'cancel_reason', r.cancel_reason,
    'destination_name', r.destination_name, 'expires_at', r.expires_at, 'closed_at', r.closed_at,
    'drivers_alerted', (select count(*) from driver_pings p where p.ride_id = r.id),
    'pickup_lat', ST_Y(r.pickup_location::geometry), 'pickup_lng', ST_X(r.pickup_location::geometry),
    'driver', case when r.status = 'CONFIRMED' then jsonb_build_object(
                'name', d.name, 'name_te', d.name_te, 'auto_number', d.auto_number, 'phone', d.phone,
                'lat', ST_Y(d.last_location::geometry), 'lng', ST_X(d.last_location::geometry),
                'distance_km', round((ST_Distance(d.last_location, r.pickup_location) / 1000)::numeric, 2),
                'seen_at', d.last_ping_at) end));
end $$;

create or replace function public.auto_passenger_cancel(p_key text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare dv auto_devices := auto_device_svc(p_key); tok text;
begin
  if dv.id is null or dv.role <> 'passenger' then return jsonb_build_object('ok', false, 'reason', 'not_paired'); end if;
  select access_token into tok from ride_requests
   where passenger_id = dv.passenger_id and status in ('AWAITING_LOCATION', 'SEARCHING', 'CONFIRMED')
   order by created_at desc limit 1;
  if tok is null then return jsonb_build_object('ok', false, 'reason', 'nothing_to_cancel'); end if;
  return cancel_ride_by_token_svc(tok) - 'driver_phone' - 'driver_id';
end $$;

-- ---------------------------------------------------------------------
-- Grants: the app (publishable key) may call only these; the key inside
-- each call decides who you are. auto_device_svc stays internal.
-- ---------------------------------------------------------------------
revoke all on function public.auto_device_svc(text) from public, anon, authenticated;
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname in ('auto_pair','auto_driver_me','auto_driver_duty','auto_driver_beat','auto_driver_poll',
                                'auto_driver_accept','auto_driver_skip','auto_driver_done','auto_passenger_me',
                                'auto_book','auto_passenger_poll','auto_passenger_cancel')
  loop
    execute format('revoke all on function %s from public', f.sig);
    execute format('grant execute on function %s to anon, authenticated', f.sig);
  end loop;
  for f in select p.oid::regprocedure as sig from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.proname in ('auto_device_svc','accept_ride_svc')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
