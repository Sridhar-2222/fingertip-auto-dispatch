-- =====================================================================
-- Fingertip Auto — migration 13: drivers do the whole ride in WhatsApp
-- (owner, 28 Nov 2026: "I want them to complete ride through bot … they get
-- menu in bot and they finish completing ride through chat bot" → "go ahead").
--
-- A driver is a drivers row whose phone is the WhatsApp number (the owner adds
-- drivers as before). In chat (bot smooth-responder v25, drivers.ts):
--   Go online  = share a location → online for dispatch_settings.wa_online_hours
--                (default 4 h; WhatsApp only lets us message them for 24 h after
--                their last message, so a short online spell keeps offers deliverable).
--   Offer      = the 5-second timer wakes the bot, which sends Accept / Skip buttons.
--                Rides that ring a WhatsApp driver wait wa_accept_seconds (default 90)
--                instead of the app's 30, because a chat message is slower to see.
--   Accept     → passenger phone + pickup map link (never the PIN).
--   Arrived    → the passenger is told (with their PIN again).
--   PIN        → the 4 digits the passenger says start the trip (5 wrong = 15-min lock, as in the app).
--   Done       → trip completed, driver online again.
--   Messages   both ways during the ride; passenger cancel / ride taken are told to the driver.
-- The driver app keeps working unchanged. No fares (owner rule). Rides only.
-- Additive: 5 columns, 1 internal helper, 12 new functions, 4 functions re-made
-- (start_search_svc, auto_wa_event, auto_wa_ride_say_svc, auto_wa_kick_svc).
-- =====================================================================

alter table public.drivers        add column if not exists wa_online_until timestamptz;
alter table public.driver_pings   add column if not exists wa_told text;
alter table public.ride_requests  add column if not exists arrived_at timestamptz,
                                  add column if not exists wa_driver_told text;
alter table public.dispatch_settings
  add column if not exists wa_online_hours   integer not null default 4  check (wa_online_hours between 1 and 20),
  add column if not exists wa_accept_seconds integer not null default 90 check (wa_accept_seconds between 30 and 300);

-- ---------------------------------------------------------------------
-- Search: app drivers with fresh GPS (as before) OR drivers online on WhatsApp.
-- When a WhatsApp driver is rung, the ride waits wa_accept_seconds.
-- Same signature and result as before.
-- ---------------------------------------------------------------------
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
     and d.last_location is not null
     and (d.last_ping_at > now() - make_interval(secs => s.gps_fresh_seconds)
          or d.wa_online_until > now())
     and ST_DWithin(d.last_location, pt, s.search_radius_m)
   order by ST_Distance(d.last_location, pt)
   limit s.max_drivers_pinged;

  get diagnostics n = row_count;
  if n = 0 then
    update ride_requests set status = 'NO_AUTO', closed_at = now(), cancel_reason = 'no_driver_in_radius'
     where id = p_ride_id;
    return;
  end if;

  if s.wa_accept_seconds > s.search_window_seconds and exists (
       select 1 from driver_pings p join drivers d on d.id = p.driver_id
        where p.ride_id = p_ride_id and d.wa_online_until > now()) then
    update ride_requests set expires_at = now() + make_interval(secs => s.wa_accept_seconds) where id = p_ride_id
    returning * into r;
    update driver_pings set expires_at = r.expires_at where ride_id = p_ride_id;
  end if;

  return query
    select d.id, d.name, d.phone, d.push_token, p.distance_km
      from driver_pings p join drivers d on d.id = p.driver_id
     where p.ride_id = p_ride_id
     order by p.distance_km;
end $$;

-- ---------------------------------------------------------------------
-- Internal: the active driver for a WhatsApp number (null when not a driver).
-- ---------------------------------------------------------------------
create or replace function public.auto_wa_driver_of(p_phone text)
returns public.drivers language sql stable security definer set search_path = public as $$
  select * from drivers where phone = p_phone and active limit 1
$$;

-- Driver's state for the chat menu: status, online, the open offer, the current ride (no PIN).
create or replace function public.auto_wa_driver_me_svc(p_phone text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare d drivers := auto_wa_driver_of(p_phone);
begin
  if d.id is null then return jsonb_build_object('ok', false, 'reason', 'not_driver'); end if;
  return jsonb_build_object(
    'ok', true, 'name', coalesce(d.name_te, d.name), 'status', d.status,
    'online', d.wa_online_until > now(), 'online_until', d.wa_online_until,
    'offer', (select jsonb_build_object('ride_id', p.ride_id, 'distance_km', p.distance_km,
                                        'destination_name', p.destination_name, 'expires_at', p.expires_at)
                from driver_pings p
               where p.driver_id = d.id and p.ping_status = 'SENT' and p.expires_at > now()
               order by p.pinged_at desc limit 1),
    'ride', (select jsonb_build_object('ride_id', r.id, 'passenger_phone', r.passenger_phone,
                                       'destination_name', r.destination_name, 'pickup_place', r.pickup_place,
                                       'arrived', r.arrived_at is not null, 'started', r.started_at is not null,
                                       'pickup_lat', ST_Y(r.pickup_location::geometry),
                                       'pickup_lng', ST_X(r.pickup_location::geometry))
               from ride_requests r
              where r.assigned_driver_id = d.id and r.status = 'CONFIRMED'
              limit 1));
end $$;

-- Go online (or refresh where I am) with a shared location.
-- reason passenger = this number is waiting to book a ride as a passenger: the pin is theirs, not a driver update.
create or replace function public.auto_wa_driver_loc_svc(p_phone text, p_lat double precision, p_lng double precision)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare d drivers := auto_wa_driver_of(p_phone); s dispatch_settings;
begin
  if d.id is null then return jsonb_build_object('ok', false, 'reason', 'not_driver'); end if;
  if exists (select 1 from ride_requests where passenger_phone = p_phone and status = 'AWAITING_LOCATION'
              and created_at > now() - interval '30 minutes') then
    return jsonb_build_object('ok', false, 'reason', 'passenger');
  end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    return jsonb_build_object('ok', false, 'reason', 'bad_location');
  end if;
  select * into s from dispatch_settings;
  update drivers
     set last_location   = ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
         last_ping_at    = now(),
         wa_online_until = now() + make_interval(hours => s.wa_online_hours),
         status          = case when status = 'BUSY' then 'BUSY' else 'AVAILABLE' end
   where id = d.id
  returning * into d;
  return jsonb_build_object('ok', true, 'status', d.status, 'hours', s.wa_online_hours);
end $$;

-- Go offline (not during a ride).
create or replace function public.auto_wa_driver_off_svc(p_phone text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d drivers := auto_wa_driver_of(p_phone);
begin
  if d.id is null then return jsonb_build_object('ok', false, 'reason', 'not_driver'); end if;
  if d.status = 'BUSY' then return jsonb_build_object('ok', false, 'reason', 'busy'); end if;
  update drivers set status = 'OFFLINE', wa_online_until = null where id = d.id;
  update driver_pings set ping_status = 'DECLINED', responded_at = now()
   where driver_id = d.id and ping_status = 'SENT';
  return jsonb_build_object('ok', true);
end $$;

-- The offer this driver answers: the named ride if it rang them, else their latest open offer.
create or replace function public.auto_wa_driver_offer(p_driver uuid, p_ride uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select p.ride_id from driver_pings p
   where p.driver_id = p_driver and (p_ride is null or p.ride_id = p_ride)
     and (p_ride is not null or (p.ping_status = 'SENT' and p.expires_at > now()))
   order by p.pinged_at desc limit 1
$$;

-- Accept. First accept wins (accept_ride_svc). Gives the passenger's phone and pickup point, never the PIN.
create or replace function public.auto_wa_driver_accept_svc(p_phone text, p_ride uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare d drivers := auto_wa_driver_of(p_phone); rid uuid; res jsonb; pp text;
begin
  if d.id is null then return jsonb_build_object('ok', false, 'reason', 'not_driver'); end if;
  rid := auto_wa_driver_offer(d.id, p_ride);
  if rid is null then return jsonb_build_object('ok', false, 'reason', 'no_offer'); end if;
  res := accept_ride_svc(rid, d.id);
  if not coalesce((res->>'ok')::boolean, false) then return jsonb_build_object('ok', false, 'reason', res->>'reason'); end if;
  select pickup_place into pp from ride_requests where id = rid;
  return jsonb_build_object('ok', true, 'ride_id', rid,
    'passenger_phone', res->>'passenger_phone', 'destination_name', res->>'destination_name', 'pickup_place', pp,
    'pickup_lat', (res->>'pickup_lat')::double precision, 'pickup_lng', (res->>'pickup_lng')::double precision);
end $$;

-- Skip.
create or replace function public.auto_wa_driver_skip_svc(p_phone text, p_ride uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d drivers := auto_wa_driver_of(p_phone); rid uuid;
begin
  if d.id is null then return jsonb_build_object('ok', false, 'reason', 'not_driver'); end if;
  rid := auto_wa_driver_offer(d.id, p_ride);
  if rid is null then return jsonb_build_object('ok', false, 'reason', 'no_offer'); end if;
  perform decline_ride_svc(rid, d.id);
  -- the driver already knows; do not send "ride closed" for this offer later
  update driver_pings set wa_told = 'DECLINED' where ride_id = rid and driver_id = d.id;
  return jsonb_build_object('ok', true);
end $$;

-- Arrived at the pickup: the passenger is told (auto_wa_event ARRIVED).
create or replace function public.auto_wa_driver_arrived_svc(p_phone text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d drivers := auto_wa_driver_of(p_phone); r ride_requests;
begin
  if d.id is null then return jsonb_build_object('ok', false, 'reason', 'not_driver'); end if;
  select * into r from ride_requests where assigned_driver_id = d.id and status = 'CONFIRMED' for update;
  if r.id is null then return jsonb_build_object('ok', false, 'reason', 'no_ride'); end if;
  if r.started_at is not null then return jsonb_build_object('ok', false, 'reason', 'started'); end if;
  if r.arrived_at is null then update ride_requests set arrived_at = now() where id = r.id; end if;
  return jsonb_build_object('ok', true);
end $$;

-- Start with the PIN the passenger says. Same rules as the app (auto_driver_start): 5 wrong = 15-minute lock.
create or replace function public.auto_wa_driver_start_svc(p_phone text, p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d drivers := auto_wa_driver_of(p_phone); r ride_requests; c text := regexp_replace(coalesce(p_code, ''), '\D', '', 'g');
begin
  if d.id is null then return jsonb_build_object('ok', false, 'reason', 'not_driver'); end if;
  select * into r from ride_requests where assigned_driver_id = d.id and status = 'CONFIRMED' for update;
  if r.id is null then return jsonb_build_object('ok', false, 'reason', 'no_ride'); end if;
  if r.started_at is not null then return jsonb_build_object('ok', true, 'already', true); end if;
  if r.start_locked_until is not null and r.start_locked_until > now() then
    return jsonb_build_object('ok', false, 'reason', 'locked');
  end if;
  if c <> r.ride_code then
    update ride_requests
       set start_fails = start_fails + 1,
           start_locked_until = case when start_fails + 1 >= 5 then now() + interval '15 minutes' else start_locked_until end
     where id = r.id returning * into r;
    if r.start_fails >= 5 then
      update ride_requests set start_fails = 0 where id = r.id;
      return jsonb_build_object('ok', false, 'reason', 'locked');
    end if;
    return jsonb_build_object('ok', false, 'reason', 'wrong', 'left', 5 - r.start_fails);
  end if;
  update ride_requests set started_at = now(), start_fails = 0, start_locked_until = null,
                           arrived_at = coalesce(arrived_at, now()) where id = r.id;
  return jsonb_build_object('ok', true);
end $$;

-- Trip done (only after a started trip). The driver is free again.
create or replace function public.auto_wa_driver_done_svc(p_phone text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d drivers := auto_wa_driver_of(p_phone); r ride_requests;
begin
  if d.id is null then return jsonb_build_object('ok', false, 'reason', 'not_driver'); end if;
  select * into r from ride_requests where assigned_driver_id = d.id and status = 'CONFIRMED';
  if r.id is null then return jsonb_build_object('ok', false, 'reason', 'no_ride'); end if;
  if r.started_at is null then return jsonb_build_object('ok', false, 'reason', 'not_started'); end if;
  return jsonb_build_object('ok', complete_ride_svc(r.id, d.id),
                            'online', (select wa_online_until > now() from drivers where id = d.id));
end $$;

-- A driver's message to the passenger during the ride (at most 30 a ride, like the app).
create or replace function public.auto_wa_driver_say_svc(p_phone text, p_body text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d drivers := auto_wa_driver_of(p_phone); r ride_requests; b text := btrim(left(coalesce(p_body, ''), 200));
begin
  if d.id is null then return jsonb_build_object('ok', false, 'reason', 'not_driver'); end if;
  select * into r from ride_requests where assigned_driver_id = d.id and status = 'CONFIRMED' limit 1;
  if r.id is null then return jsonb_build_object('ok', false, 'reason', 'no_ride'); end if;
  if b = '' then return jsonb_build_object('ok', false, 'reason', 'empty'); end if;
  if (select count(*) from ride_messages where ride_id = r.id and sender = 'driver') >= 30 then
    return jsonb_build_object('ok', false, 'reason', 'too_many');
  end if;
  -- WhatsApp passengers get it from the timer; app passengers read it in their app.
  insert into ride_messages (ride_id, sender, body, told) values (r.id, 'driver', b, r.source <> 'whatsapp');
  return jsonb_build_object('ok', true);
end $$;

-- Passenger (WhatsApp) → driver: as before, but when the driver works on WhatsApp the message waits for the timer.
create or replace function public.auto_wa_ride_say_svc(p_phone text, p_body text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r ride_requests; b text := btrim(left(coalesce(p_body, ''), 300)); wa boolean;
begin
  select * into r from ride_requests where passenger_phone = p_phone and status = 'CONFIRMED' and confirmed_at > now() - interval '3 hours'
   order by confirmed_at desc limit 1;
  if r.id is null then return jsonb_build_object('ok', false, 'reason', 'no_ride'); end if;
  if b = '' then return jsonb_build_object('ok', false, 'reason', 'empty'); end if;
  if (select count(*) from ride_messages where ride_id = r.id and sender = 'passenger') >= 30 then return jsonb_build_object('ok', false, 'reason', 'too_many'); end if;
  select wa_online_until is not null into wa from drivers where id = r.assigned_driver_id;
  insert into ride_messages (ride_id, sender, body, told) values (r.id, 'passenger', b, not coalesce(wa, false));
  return jsonb_build_object('ok', true);
end $$;

-- Passenger news: ARRIVED added (driver at the pickup, trip not started yet).
create or replace function public.auto_wa_event(r public.ride_requests)
returns text language sql immutable as $$
  select case
    when r.status = 'CONFIRMED' and r.started_at is not null then 'STARTED'
    when r.status = 'CONFIRMED' and r.arrived_at is not null then 'ARRIVED'
    when r.status = 'CONFIRMED' then 'CONFIRMED'
    when r.status = 'COMPLETED' then 'COMPLETED'
    when r.status = 'NO_AUTO' and coalesce(r.cancel_reason, '') <> 'no_driver_in_radius' then 'NO_AUTO'
    when r.status = 'CANCELLED' and coalesce(r.cancel_reason, '') not in ('passenger', 'superseded', 'no_location') then 'CANCELLED'
  end
$$;

-- ---------------------------------------------------------------------
-- Driver news for the bot, each returned once:
--   OFFER     a ride rang this WhatsApp driver (Accept / Skip buttons)
--   CLOSED    an offer they did not answer was taken by another auto, timed out or cancelled
--   CANCELLED the passenger cancelled the driver's confirmed ride
--   MSG       a passenger message during the ride
-- ---------------------------------------------------------------------
create or replace function public.auto_wa_driver_due_svc()
returns table (kind text, phone text, ride_id uuid, distance_km numeric, destination_name text,
               pickup_place text, expires_at timestamptz, body text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
begin
  return query
  with offers as (
    select p.id from driver_pings p join drivers d on d.id = p.driver_id
     where p.ping_status = 'SENT' and p.wa_told is null and p.expires_at > now() and d.wa_online_until > now()
     order by p.pinged_at limit 50 for update of p skip locked),
  o as (update driver_pings p set wa_told = 'SENT' from offers where p.id = offers.id returning p.*)
  select 'OFFER'::text, d.phone, o.ride_id, o.distance_km, o.destination_name, r.pickup_place, o.expires_at, null::text
    from o join drivers d on d.id = o.driver_id join ride_requests r on r.id = o.ride_id;

  return query
  with closed as (
    select p.id from driver_pings p
     where p.wa_told = 'SENT' and p.ping_status in ('TAKEN', 'TIMEOUT', 'DECLINED') and p.pinged_at > now() - interval '1 hour'
     limit 50 for update of p skip locked),
  c as (update driver_pings p set wa_told = 'CLOSED' from closed where p.id = closed.id returning p.*)
  select 'CLOSED'::text, d.phone, c.ride_id, c.distance_km, c.destination_name, null::text, null::timestamptz, c.ping_status
    from c join drivers d on d.id = c.driver_id;

  return query
  with gone as (
    select r.id from ride_requests r join drivers d on d.id = r.assigned_driver_id
     where r.status = 'CANCELLED' and r.wa_driver_told is null and d.wa_online_until is not null
       and r.closed_at > now() - interval '1 hour'
     limit 50 for update of r skip locked),
  g as (update ride_requests r set wa_driver_told = 'CANCELLED' from gone where r.id = gone.id returning r.*)
  select 'CANCELLED'::text, d.phone, g.id, null::numeric, g.destination_name, null::text, null::timestamptz, null::text
    from g join drivers d on d.id = g.assigned_driver_id;

  return query
  with msgs as (
    select m.id from ride_messages m join ride_requests r on r.id = m.ride_id
     where m.sender = 'passenger' and not m.told and m.created_at > now() - interval '1 hour'
     order by m.id limit 50 for update of m skip locked),
  u as (update ride_messages m set told = true from msgs where m.id = msgs.id returning m.*)
  select 'MSG'::text, d.phone, u.ride_id, null::numeric, null::text, null::text, null::timestamptz, u.body
    from u join ride_requests r on r.id = u.ride_id join drivers d on d.id = r.assigned_driver_id
   order by u.id;
end $$;

-- Is there driver news waiting? (for the timer)
create or replace function public.auto_wa_driver_pending()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from driver_pings p join drivers d on d.id = p.driver_id
                  where p.ping_status = 'SENT' and p.wa_told is null and p.expires_at > now() and d.wa_online_until > now())
      or exists (select 1 from driver_pings p
                  where p.wa_told = 'SENT' and p.ping_status in ('TAKEN', 'TIMEOUT', 'DECLINED') and p.pinged_at > now() - interval '1 hour')
      or exists (select 1 from ride_requests r join drivers d on d.id = r.assigned_driver_id
                  where r.status = 'CANCELLED' and r.wa_driver_told is null and d.wa_online_until is not null
                    and r.closed_at > now() - interval '1 hour')
      or exists (select 1 from ride_messages m
                  where m.sender = 'passenger' and not m.told and m.created_at > now() - interval '1 hour')
$$;

-- The timer also wakes the bot for driver news.
create or replace function public.auto_wa_kick_svc()
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare url text; secret text;
begin
  if not exists (select 1 from ride_requests r where r.source = 'whatsapp' and r.created_at > now() - interval '3 hours'
                   and auto_wa_event(r) is not null and auto_wa_event(r) is distinct from r.wa_told)
     and not exists (select 1 from ride_messages m join ride_requests r on r.id = m.ride_id
                      where m.sender = 'driver' and not m.told and r.source = 'whatsapp' and m.created_at > now() - interval '1 hour')
     and not auto_wa_driver_pending() then
    return false;
  end if;
  select decrypted_secret into url    from vault.decrypted_secrets where name = 'fingertip_bot_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'fingertip_bot_secret';
  if url is null or secret is null then return false; end if;
  perform net.http_post(url := url, headers := jsonb_build_object('Content-Type', 'application/json', 'x-auto-notify', secret),
                        body := '{"kind":"auto_news"}'::jsonb);
  return true;
end $$;

-- ---------- grants: the bot (service role) only ----------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname in ('auto_wa_driver_of', 'auto_wa_driver_offer', 'auto_wa_driver_pending',
                                'auto_wa_driver_me_svc', 'auto_wa_driver_loc_svc', 'auto_wa_driver_off_svc',
                                'auto_wa_driver_accept_svc', 'auto_wa_driver_skip_svc', 'auto_wa_driver_arrived_svc',
                                'auto_wa_driver_start_svc', 'auto_wa_driver_done_svc', 'auto_wa_driver_say_svc',
                                'auto_wa_driver_due_svc', 'auto_wa_ride_say_svc', 'auto_wa_kick_svc', 'start_search_svc')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;
grant execute on function
  public.auto_wa_driver_me_svc(text), public.auto_wa_driver_loc_svc(text, double precision, double precision),
  public.auto_wa_driver_off_svc(text), public.auto_wa_driver_accept_svc(text, uuid), public.auto_wa_driver_skip_svc(text, uuid),
  public.auto_wa_driver_arrived_svc(text), public.auto_wa_driver_start_svc(text, text), public.auto_wa_driver_done_svc(text),
  public.auto_wa_driver_say_svc(text, text), public.auto_wa_driver_due_svc(), public.auto_wa_ride_say_svc(text, text),
  public.start_search_svc(uuid, double precision, double precision)
  to service_role;
