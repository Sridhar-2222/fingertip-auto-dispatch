-- =====================================================================
-- Fingertip Auto — migration 4: Rapido-style start code (owner, 26 Nov 2026:
-- "Rapido keeps the OTP on the screen. The customer just informs it to the
-- driver … no one pays anything"; "for now, everyone pin on screen").
--
--  * The PASSENGER's screen shows the 4-digit ride_code (already made per ride).
--  * The DRIVER never receives it any more. At pickup the driver types (or
--    says) the code the passenger tells them -> auto_driver_start.
--  * "Trip done" works only after the trip was started with the right code.
--  * 5 wrong codes lock starting for 15 minutes.
--  * The old sign-in driver functions (*_self) are not used by the app and
--    showed the code to the driver, so the app roles lose access to them.
-- Additive: 3 new columns, 1 new function, 3 functions re-made.
-- =====================================================================

alter table public.ride_requests
  add column if not exists started_at          timestamptz,
  add column if not exists start_fails         integer not null default 0,
  add column if not exists start_locked_until  timestamptz;

-- Driver: current ride WITHOUT the code; says whether it has started.
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
    'ride', (select jsonb_build_object('ride_id', r.id,
                                       'passenger_phone', r.passenger_phone,
                                       'destination_name', r.destination_name,
                                       'started', r.started_at is not null,
                                       'pickup_lat', ST_Y(r.pickup_location::geometry),
                                       'pickup_lng', ST_X(r.pickup_location::geometry))
               from ride_requests r
              where r.assigned_driver_id = dv.driver_id and r.status = 'CONFIRMED'
              limit 1));
end $$;

-- Driver accept: same as before, minus the code.
create or replace function public.auto_driver_accept(p_key text, p_ride_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare dv auto_devices := auto_device_svc(p_key);
begin
  if dv.id is null or dv.role <> 'driver' then return jsonb_build_object('ok', false, 'reason', 'not_paired'); end if;
  return accept_ride_svc(p_ride_id, dv.driver_id) - 'access_token' - 'other_driver_ids' - 'ride_code';
end $$;

-- Driver: start the trip with the code the passenger tells them.
-- Returns {ok} or {ok:false, reason: wrong(left) | locked | not_your_ride}.
create or replace function public.auto_driver_start(p_key text, p_ride_id uuid, p_code text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  dv auto_devices := auto_device_svc(p_key);
  r  ride_requests;
  c  text := regexp_replace(coalesce(p_code, ''), '\D', '', 'g');
begin
  if dv.id is null or dv.role <> 'driver' then return jsonb_build_object('ok', false, 'reason', 'not_paired'); end if;
  select * into r from ride_requests
   where id = p_ride_id and assigned_driver_id = dv.driver_id and status = 'CONFIRMED' for update;
  if r.id is null then return jsonb_build_object('ok', false, 'reason', 'not_your_ride'); end if;
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
      update ride_requests set start_fails = 0 where id = r.id;   -- 5 fresh tries after the lock
      return jsonb_build_object('ok', false, 'reason', 'locked');
    end if;
    return jsonb_build_object('ok', false, 'reason', 'wrong', 'left', 5 - r.start_fails);
  end if;
  update ride_requests set started_at = now(), start_fails = 0, start_locked_until = null where id = r.id;
  return jsonb_build_object('ok', true);
end $$;

-- Driver: trip done only after a started trip.
create or replace function public.auto_driver_done(p_key text, p_ride_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare dv auto_devices := auto_device_svc(p_key);
begin
  if dv.id is null or dv.role <> 'driver' then return jsonb_build_object('ok', false, 'reason', 'not_paired'); end if;
  if not exists (select 1 from ride_requests where id = p_ride_id and assigned_driver_id = dv.driver_id
                  and status = 'CONFIRMED' and started_at is not null) then
    return jsonb_build_object('ok', false, 'reason', 'not_started');
  end if;
  return jsonb_build_object('ok', complete_ride_svc(p_ride_id, dv.driver_id));
end $$;

-- Passenger: same as before plus 'started'.
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
    'started', r.started_at is not null,
    'destination_name', r.destination_name, 'expires_at', r.expires_at, 'closed_at', r.closed_at,
    'drivers_alerted', (select count(*) from driver_pings p where p.ride_id = r.id),
    'pickup_lat', ST_Y(r.pickup_location::geometry), 'pickup_lng', ST_X(r.pickup_location::geometry),
    'driver', case when r.status = 'CONFIRMED' then jsonb_build_object(
                'name', d.name, 'name_te', d.name_te, 'auto_number', d.auto_number, 'phone', d.phone,
                'lat', ST_Y(d.last_location::geometry), 'lng', ST_X(d.last_location::geometry),
                'distance_km', round((ST_Distance(d.last_location, r.pickup_location) / 1000)::numeric, 2),
                'seen_at', d.last_ping_at) end));
end $$;

revoke all on function public.auto_driver_start(text, uuid, text) from public;
grant execute on function public.auto_driver_start(text, uuid, text) to anon, authenticated;

-- Old sign-in driver functions: unused by the app; one of them showed the code to the driver.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname in ('accept_ride_self','complete_ride_self','decline_ride_self','claim_driver_self',
                                'driver_current_ride_self','driver_heartbeat_self','driver_me_self',
                                'driver_open_ping_self','set_duty_self')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;
