-- LOCAL TESTING ONLY. Run against a throwaway database after the migration.
-- Every block raises an error if a rule is broken.
-- Coordinates: Karimnagar bus stand ≈ 18.4386 N, 79.1288 E; 0.009° lat ≈ 1 km.

set search_path = public, extensions;
truncate public.driver_pings, public.ride_requests, public.drivers, public.processed_messages cascade;

insert into public.drivers (id, user_id, name, phone, auto_number, status, last_location, last_ping_at) values
 ('00000000-0000-0000-0000-00000000000a','10000000-0000-0000-0000-00000000000a','Ravi',   '919800000001','TS02UB0001','AVAILABLE', ST_MakePoint(79.1288,18.4386+0.0045)::geography, now()),               -- 0.5 km
 ('00000000-0000-0000-0000-00000000000b','10000000-0000-0000-0000-00000000000b','Srinu',  '919800000002','TS02UB0002','AVAILABLE', ST_MakePoint(79.1288,18.4386+0.0108)::geography, now()),               -- 1.2 km
 ('00000000-0000-0000-0000-00000000000c','10000000-0000-0000-0000-00000000000c','Mahesh', '919800000003','TS02UB0003','AVAILABLE', ST_MakePoint(79.1288,18.4386+0.0250)::geography, now()),               -- 2.8 km
 ('00000000-0000-0000-0000-00000000000d',null,                                  'Far',    '919800000004','TS02UB0004','AVAILABLE', ST_MakePoint(79.1288,18.4386+0.0320)::geography, now()),               -- 3.6 km, out
 ('00000000-0000-0000-0000-00000000000e',null,                                  'Stale',  '919800000005','TS02UB0005','AVAILABLE', ST_MakePoint(79.1288,18.4386+0.0027)::geography, now()-interval '5 min'), -- old GPS, out
 ('00000000-0000-0000-0000-00000000000f',null,                                  'Offline','919800000006','TS02UB0006','OFFLINE',   ST_MakePoint(79.1288,18.4386+0.0018)::geography, now());              -- off duty, out

-- 1. Radius, freshness, status filters and nearest-first order
do $$
declare r ride_requests; ids uuid[]; d numeric[];
begin
  r := create_ride_svc('919811111111', 'కొత్తరాంపూర్ కి ఆటో కావాలి', 'KOTHIRAMPUR');
  assert r.status = 'AWAITING_LOCATION' and r.destination_name = 'KOTHIRAMPUR', 'ride created';
  assert length(r.access_token) = 36 and r.ride_code ~ '^\d{4}$', 'token long, code 4 digits';
  select array_agg(driver_id order by distance_km), array_agg(distance_km order by distance_km)
    into ids, d from start_search_svc(r.id, 18.4386, 79.1288);
  assert ids = array['00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000b',
                     '00000000-0000-0000-0000-00000000000c']::uuid[], 'only 3 eligible drivers, nearest first: ' || ids::text;
  assert d[1] between 0.45 and 0.55, 'distance in km';
  select * into r from ride_requests where id = r.id;
  assert r.status = 'SEARCHING' and r.expires_at between now() + interval '29 s' and now() + interval '31 s', '30 s window';
  assert (select count(*) from start_search_svc(r.id, 18.4386, 79.1288)) = 0, 'second location pin is a no-op';
  assert (select count(*) from driver_pings where ride_id = r.id) = 3, 'no duplicate pings';
  raise notice 'PASS 1 radius / freshness / order';
end $$;

-- 2. First accept wins; second gets "taken"; other pings marked TAKEN
do $$
declare rid uuid; a jsonb; b jsonb;
begin
  select id into rid from ride_requests where passenger_phone = '919811111111' and status = 'SEARCHING';
  a := accept_ride_svc(rid, '00000000-0000-0000-0000-00000000000b');
  b := accept_ride_svc(rid, '00000000-0000-0000-0000-00000000000a');
  assert (a->>'ok')::boolean and a->'driver'->>'name' = 'Srinu', 'first accept wins';
  assert a->>'passenger_phone' = '919811111111' and (a->>'pickup_lat')::numeric between 18.43 and 18.44, 'winner gets pin + phone';
  assert jsonb_array_length(a->'other_driver_ids') = 2, 'two others to dismiss';
  assert not (b->>'ok')::boolean and b->>'reason' = 'taken', 'second accept refused';
  assert (select status from drivers where name = 'Srinu') = 'BUSY', 'winner BUSY';
  assert (select status from drivers where name = 'Ravi') = 'AVAILABLE', 'loser still AVAILABLE';
  assert (select count(*) from driver_pings where ride_id = rid and ping_status = 'TAKEN') = 2, 'others TAKEN';
  assert accept_ride_svc(rid, '00000000-0000-0000-0000-00000000000d')->>'reason' = 'not_pinged', 'unpinged driver refused';
  raise notice 'PASS 2 first accept wins';
end $$;

-- 3. A BUSY driver can't take a second ride
do $$
declare r ride_requests; x jsonb;
begin
  -- Srinu is BUSY so won't be pinged; force a ping to simulate an alert that was already on screen
  r := create_ride_svc('919822222222', null, 'KAMAN');
  perform start_search_svc(r.id, 18.4386, 79.1288);
  insert into driver_pings (ride_id, driver_id, distance_km, expires_at)
  values (r.id, '00000000-0000-0000-0000-00000000000b', 1.2, now() + interval '30 s');
  x := accept_ride_svc(r.id, '00000000-0000-0000-0000-00000000000b');
  assert x->>'reason' = 'driver_not_available', 'busy driver refused: ' || x::text;
  assert (select status from ride_requests where id = r.id) = 'SEARCHING', 'ride untouched';
  raise notice 'PASS 3 no double-booking of a driver';
end $$;

-- 4. Timeout closes the ride and returns it once
do $$
declare rid uuid; n int;
begin
  select id into rid from ride_requests where passenger_phone = '919822222222';
  update ride_requests set expires_at = now() - interval '1 s' where id = rid;
  assert accept_ride_svc(rid, '00000000-0000-0000-0000-00000000000a')->>'reason' = 'expired', 'late accept refused';
  select count(*) into n from expire_due_rides_svc() where ride_id = rid;
  assert n = 1, 'expired ride returned';
  assert (select status from ride_requests where id = rid) = 'NO_AUTO', 'NO_AUTO after timeout';
  assert (select count(*) from driver_pings where ride_id = rid and ping_status = 'SENT') = 0, 'pings closed';
  assert (select count(*) from expire_due_rides_svc() where ride_id = rid) = 0, 'returned only once';
  raise notice 'PASS 4 timeout';
end $$;

-- 5. Nobody within 3 km → NO_AUTO immediately
do $$
declare r ride_requests;
begin
  r := create_ride_svc('919833333333', null, 'HUSNABAD');
  assert (select count(*) from start_search_svc(r.id, 18.60, 79.30)) = 0, 'no drivers';
  assert (select status from ride_requests where id = r.id) = 'NO_AUTO', 'NO_AUTO';
  raise notice 'PASS 5 zero drivers';
end $$;

-- 6. Everyone taps SKIP → closes without waiting for the timer
do $$
declare r ride_requests; x jsonb;
begin
  r := create_ride_svc('919844444444', null, null);
  perform start_search_svc(r.id, 18.4386, 79.1288);   -- Ravi + Mahesh (Srinu busy)
  x := decline_ride_svc(r.id, '00000000-0000-0000-0000-00000000000a');
  assert not (x->>'all_declined')::boolean, 'one left';
  x := decline_ride_svc(r.id, '00000000-0000-0000-0000-00000000000c');
  assert (x->>'all_declined')::boolean, 'all declined';
  assert (select status from ride_requests where id = r.id) = 'NO_AUTO', 'closed';
  raise notice 'PASS 6 all declined';
end $$;

-- 7. A new voice note replaces a ride still waiting for its pin
do $$
declare r1 ride_requests; r2 ride_requests;
begin
  r1 := create_ride_svc('919855555555', null, 'KAMAN');
  r2 := create_ride_svc('919855555555', null, 'ALGUNUR');
  assert (select status from ride_requests where id = r1.id) = 'CANCELLED', 'old one cancelled';
  assert (awaiting_ride_svc('919855555555')).id = r2.id, 'latest is awaiting';
  raise notice 'PASS 7 superseded';
end $$;

-- 8. Complete frees the driver; passenger cancel frees the driver
do $$
declare rid uuid; r ride_requests; a jsonb; c jsonb;
begin
  select id into rid from ride_requests where passenger_phone = '919811111111';
  assert complete_ride_svc(rid, '00000000-0000-0000-0000-00000000000a') = false, 'wrong driver cannot complete';
  assert complete_ride_svc(rid, '00000000-0000-0000-0000-00000000000b'), 'complete';
  assert (select status from drivers where name = 'Srinu') = 'AVAILABLE', 'freed after complete';

  r := create_ride_svc('919866666666', null, 'KAMAN');
  perform start_search_svc(r.id, 18.4386, 79.1288);
  a := accept_ride_svc(r.id, '00000000-0000-0000-0000-00000000000a');
  c := cancel_ride_by_token_svc(r.access_token);
  assert (c->>'ok')::boolean and c->>'driver_phone' = '919800000001', 'cancel returns driver to tell';
  assert (select status from drivers where name = 'Ravi') = 'AVAILABLE', 'freed after cancel';
  assert not (cancel_ride_by_token_svc(r.access_token)->>'ok')::boolean, 'cancel twice is a no-op';
  raise notice 'PASS 8 complete / cancel';
end $$;

-- 9. Message de-dup and read-receipt fallback claim
do $$
declare r ride_requests; n int;
begin
  assert claim_message_svc('wamid.TEST1'), 'first time';
  assert not claim_message_svc('wamid.TEST1'), 'retry ignored';

  r := create_ride_svc('919877777777', null, 'KAMAN');
  perform start_search_svc(r.id, 18.4386, 79.1288);
  perform accept_ride_svc(r.id, '00000000-0000-0000-0000-00000000000c');
  perform set_notify_wamid_svc(r.id, 'wamid.OUT1');
  assert (select count(*) from claim_fallback_calls_svc() where ride_id = r.id) = 0, 'too early to call';
  update ride_requests set confirmed_at = now() - interval '25 s' where id = r.id;
  select count(*) into n from claim_fallback_calls_svc() where ride_id = r.id;
  assert n = 1, 'unread after 20 s → call';
  assert (select count(*) from claim_fallback_calls_svc() where ride_id = r.id) = 0, 'only one call';
  perform mark_notify_read_svc('wamid.OUT1');
  assert (select notify_read_at is not null from ride_requests where id = r.id), 'read stored';
  raise notice 'PASS 9 dedup / fallback';
end $$;

-- 10. Permissions: anon sees only the token view; drivers see only their own data
do $$ begin
  perform set_config('request.jwt.claim.sub', '', true);
end $$;
set role anon;
do $$
declare tok text; j jsonb; ok boolean := false;
begin
  begin
    perform 1 from public.ride_requests limit 1;
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'anon cannot read ride_requests';
  ok := false;
  begin
    perform create_ride_svc('919800000000', null, null);
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'anon cannot call service functions';
  assert ride_status_by_token('short') is null, 'short token rejected';
  raise notice 'PASS 10a anon locked down';
end $$;
reset role;

do $$
declare tok text;
begin
  select access_token into tok from ride_requests where passenger_phone = '919877777777';
  perform set_config('test.tok', tok, false);
end $$;
set role anon;
do $$
declare j jsonb;
begin
  j := ride_status_by_token(current_setting('test.tok'));
  assert j->>'status' = 'CONFIRMED' and j->'driver'->>'name' = 'Mahesh', 'token shows driver: ' || coalesce(j::text,'null');
  assert j->>'passenger_phone' is null, 'no passenger phone in link';
  raise notice 'PASS 10b token view';
end $$;
reset role;

grant select on public.drivers, public.driver_pings to authenticated;  -- Supabase grants this by default
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-00000000000a', false);
set role authenticated;
do $$
declare n int; s text;
begin
  select count(*) into n from public.drivers;
  assert n = 1, 'driver sees only own row, saw ' || n;
  select count(*) into n from public.driver_pings
   where driver_id <> '00000000-0000-0000-0000-00000000000a';
  assert n = 0, 'driver sees only own pings';
  perform driver_heartbeat_self(18.44, 79.13);
  s := set_duty_self(false);
  assert s = 'OFFLINE', 'duty off';
  s := set_duty_self(true);
  assert s = 'AVAILABLE', 'duty on';
  raise notice 'PASS 10c driver self-service';
end $$;
reset role;

select 'ALL SQL TESTS PASSED' as result;
