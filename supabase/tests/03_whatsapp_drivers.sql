-- LOCAL TESTING ONLY. Run after all migrations on a throwaway database. Every block raises an error if a rule is broken.
-- Karimnagar bus stand ≈ 18.4386 N, 79.1288 E; 0.009° lat ≈ 1 km.
set search_path = public, extensions;
truncate public.ride_messages, public.driver_pings, public.ride_requests, public.drivers cascade;

insert into drivers (id, name, phone, auto_number) values
 ('00000000-0000-0000-0000-0000000000a1', 'Ravi',  '919800000001', 'TS02UB0001'),
 ('00000000-0000-0000-0000-0000000000a2', 'Srinu', '919800000002', 'TS02UB0002'),
 ('00000000-0000-0000-0000-0000000000a3', 'Far',   '919800000003', 'TS02UB0003');

-- 1. Not a driver, bad location
do $$ declare j jsonb; begin
  j := auto_wa_driver_loc_svc('919811111111', 18.44, 79.13);
  assert j->>'reason' = 'not_driver', 'unknown number is not a driver';
  j := auto_wa_driver_loc_svc('919800000001', 95, 79.13);
  assert j->>'reason' = 'bad_location', 'bad latitude refused';
end $$;

-- 2. Go online: AVAILABLE, online for the default 4 hours
do $$ declare j jsonb; m jsonb; begin
  j := auto_wa_driver_loc_svc('919800000001', 18.4386 + 0.0045, 79.1288);
  assert (j->>'ok')::boolean and j->>'status' = 'AVAILABLE' and (j->>'hours')::int = 4, 'online';
  perform auto_wa_driver_loc_svc('919800000002', 18.4386 + 0.0108, 79.1288);
  perform auto_wa_driver_loc_svc('919800000003', 18.4386 + 0.0900, 79.1288);   -- 10 km away
  m := auto_wa_driver_me_svc('919800000001');
  assert (m->>'online')::boolean and m->'offer' = 'null'::jsonb and m->'ride' = 'null'::jsonb, 'me: online, no offer, no ride';
end $$;

-- 3. A ride rings the two near WhatsApp drivers (no app GPS), waits 90 s, not the far one
do $$ declare r ride_requests; n int; rr ride_requests; begin
  r := auto_wa_book_svc('919811111111', null, 'BUS_STAND');
  select count(*) into n from start_search_svc(r.id, 18.4386, 79.1288);
  assert n = 2, 'two WhatsApp drivers rung, got ' || n;
  select * into rr from ride_requests where id = r.id;
  assert rr.expires_at > now() + interval '80 seconds', 'WhatsApp driver gets 90 s';
  assert (select count(*) from driver_pings where ride_id = r.id and expires_at = rr.expires_at) = 2, 'pings share the window';
end $$;

-- 4. Offers come out once, with the ride's details; the next call is empty
do $$ declare n int; begin
  select count(*) into n from auto_wa_driver_due_svc() where kind = 'OFFER';
  assert n = 2, 'two offers, got ' || n;
  select count(*) into n from auto_wa_driver_due_svc();
  assert n = 0, 'nothing twice';
  assert not auto_wa_driver_pending(), 'no news left';
end $$;

-- 5. Ravi accepts (nearest); Srinu then accepts too late and is told it is taken
do $$ declare j jsonb; begin
  j := auto_wa_driver_accept_svc('919800000001', null);
  assert (j->>'ok')::boolean and j->>'passenger_phone' = '919811111111', 'accept gives passenger phone';
  assert not (j ? 'ride_code') and not (j ? 'access_token'), 'no PIN, no token for the driver';
  j := auto_wa_driver_accept_svc('919800000002', null);
  assert not (j->>'ok')::boolean and j->>'reason' = 'no_offer', 'second driver has no open offer: ' || j::text;
  assert (select status from drivers where phone = '919800000001') = 'BUSY', 'Ravi busy';
end $$;

-- 6. Srinu hears the offer closed (once)
do $$ declare n int; begin
  select count(*) into n from auto_wa_driver_due_svc() where kind = 'CLOSED' and phone = '919800000002';
  assert n = 1, 'Srinu told closed once, got ' || n;
  select count(*) into n from auto_wa_driver_due_svc() where kind = 'CLOSED';
  assert n = 0, 'closed only once';
end $$;

-- 7. Passenger news: CONFIRMED, then ARRIVED
do $$ declare r ride_requests; j jsonb; begin
  select * into r from ride_requests where passenger_phone = '919811111111';
  assert auto_wa_event(r) = 'CONFIRMED', 'confirmed news';
  j := auto_wa_driver_arrived_svc('919800000001');
  assert (j->>'ok')::boolean, 'arrived ok';
  select * into r from ride_requests where passenger_phone = '919811111111';
  assert auto_wa_event(r) = 'ARRIVED', 'arrived news for the passenger';
  assert (auto_wa_driver_me_svc('919800000001')->'ride'->>'arrived')::boolean, 'me shows arrived';
end $$;

-- 8. Done before start is refused; wrong PIN counts; locked after 5; right PIN starts
do $$ declare r ride_requests; j jsonb; i int; begin
  select * into r from ride_requests where passenger_phone = '919811111111';
  j := auto_wa_driver_done_svc('919800000001');
  assert j->>'reason' = 'not_started', 'cannot finish before start';
  j := auto_wa_driver_start_svc('919800000001', case when r.ride_code = '0000' then '1111' else '0000' end);
  assert j->>'reason' = 'wrong' and (j->>'left')::int = 4, 'wrong PIN: 4 left';
  for i in 1..3 loop perform auto_wa_driver_start_svc('919800000001', case when r.ride_code = '0000' then '1111' else '0000' end); end loop;
  j := auto_wa_driver_start_svc('919800000001', case when r.ride_code = '0000' then '1111' else '0000' end);
  assert j->>'reason' = 'locked', '5th wrong PIN locks';
  j := auto_wa_driver_start_svc('919800000001', r.ride_code);
  assert j->>'reason' = 'locked', 'right PIN still locked while locked';
  update ride_requests set start_locked_until = null where id = r.id;
  j := auto_wa_driver_start_svc('919800000001', ' ' || substr(r.ride_code, 1, 2) || '-' || substr(r.ride_code, 3));
  assert (j->>'ok')::boolean, 'right PIN (spaces and dashes ignored) starts';
  select * into r from ride_requests where id = r.id;
  assert auto_wa_event(r) = 'STARTED', 'started news';
end $$;

-- 9. Messages both ways during the ride, each delivered once
do $$ declare j jsonb; n int; begin
  j := auto_wa_ride_say_svc('919811111111', 'I am at the gate');
  assert (j->>'ok')::boolean, 'passenger message saved';
  select count(*) into n from auto_wa_driver_due_svc() where kind = 'MSG' and phone = '919800000001' and body = 'I am at the gate';
  assert n = 1, 'driver gets passenger message once';
  select count(*) into n from auto_wa_driver_due_svc() where kind = 'MSG';
  assert n = 0, 'not twice';
  j := auto_wa_driver_say_svc('919800000001', 'Coming');
  assert (j->>'ok')::boolean, 'driver message saved';
  select count(*) into n from auto_wa_msgs_due_svc() where body = 'Coming';
  assert n = 1, 'existing timer delivers it to the passenger';
  j := auto_wa_driver_say_svc('919800000002', 'hello');
  assert j->>'reason' = 'no_ride', 'a driver without a ride cannot message';
end $$;

-- 10. Done: ride completed, Ravi free (still online)
do $$ declare j jsonb; r ride_requests; begin
  j := auto_wa_driver_done_svc('919800000001');
  assert (j->>'ok')::boolean and (j->>'online')::boolean, 'done; still online';
  assert (select status from drivers where phone = '919800000001') = 'AVAILABLE', 'Ravi free again';
  select * into r from ride_requests where passenger_phone = '919811111111';
  assert r.status = 'COMPLETED' and auto_wa_event(r) = 'COMPLETED', 'completed';
  assert auto_wa_driver_done_svc('919800000001')->>'reason' = 'no_ride', 'no second done';
end $$;

-- 11. Skip: Srinu skips, Ravi accepts later; the skipper hears nothing extra
do $$ declare r ride_requests; n int; j jsonb; begin
  update drivers set status = 'AVAILABLE' where phone = '919800000002';
  r := auto_wa_book_svc('919822222222', null, 'KAMAN');
  perform start_search_svc(r.id, 18.4386, 79.1288);
  perform auto_wa_driver_due_svc();
  j := auto_wa_driver_skip_svc('919800000002', null);
  assert (j->>'ok')::boolean, 'skip ok';
  select count(*) into n from auto_wa_driver_due_svc() where kind = 'CLOSED' and phone = '919800000002';
  assert n = 0, 'skipper is not told "closed"';
  j := auto_wa_driver_accept_svc('919800000001', r.id);
  assert (j->>'ok')::boolean, 'Ravi accepts by ride id';
end $$;

-- 12. Passenger cancels: the driver is told once and is free
do $$ declare n int; begin
  perform cancel_by_phone_svc('919822222222');
  select count(*) into n from auto_wa_driver_due_svc() where kind = 'CANCELLED' and phone = '919800000001';
  assert n = 1, 'driver told of the cancel once, got ' || n;
  assert (select status from drivers where phone = '919800000001') = 'AVAILABLE', 'Ravi free';
  select count(*) into n from auto_wa_driver_due_svc() where kind = 'CANCELLED';
  assert n = 0, 'only once';
end $$;

-- 13. Offline: not rung; offline during a ride is refused
do $$ declare r ride_requests; n int; j jsonb; begin
  j := auto_wa_driver_off_svc('919800000001');
  assert (j->>'ok')::boolean, 'offline ok';
  assert (select status from drivers where phone = '919800000001') = 'OFFLINE', 'status OFFLINE';
  update drivers set status = 'OFFLINE', wa_online_until = null where phone = '919800000002';
  r := auto_wa_book_svc('919833333333', null, 'KAMAN');
  select count(*) into n from start_search_svc(r.id, 18.4386, 79.1288);
  assert n = 0, 'nobody online: no auto';
  perform auto_wa_driver_loc_svc('919800000001', 18.4386 + 0.0045, 79.1288);
  update drivers set status = 'BUSY' where phone = '919800000001';
  j := auto_wa_driver_off_svc('919800000001');
  assert j->>'reason' = 'busy', 'cannot go offline while busy';
  update drivers set status = 'AVAILABLE' where phone = '919800000001';
end $$;

-- 14. An online spell that ended is not rung; app drivers with fresh GPS still are (30 s window)
do $$ declare r ride_requests; n int; rr ride_requests; begin
  update drivers set wa_online_until = now() - interval '1 minute', last_ping_at = now() - interval '10 minutes' where phone = '919800000001';
  r := auto_wa_book_svc('919844444444', null, 'KAMAN');
  select count(*) into n from start_search_svc(r.id, 18.4386, 79.1288);
  assert n = 0, 'expired online spell is not rung';
  update drivers set last_ping_at = now() where phone = '919800000001';   -- the app heartbeat
  r := auto_wa_book_svc('919855555555', null, 'KAMAN');
  select count(*) into n from start_search_svc(r.id, 18.4386, 79.1288);
  assert n = 1, 'app driver with fresh GPS is rung';
  select * into rr from ride_requests where id = r.id;
  assert rr.expires_at < now() + interval '40 seconds', 'app-only search keeps the 30 s window';
end $$;

-- 15. A number waiting to book as a passenger does not become a driver position
do $$ declare r ride_requests; j jsonb; begin
  r := auto_wa_book_svc('919800000003', null, 'KAMAN');   -- a driver booking an auto for themselves
  j := auto_wa_driver_loc_svc('919800000003', 18.44, 79.13);
  assert j->>'reason' = 'passenger', 'location belongs to the passenger booking';
end $$;

-- 16. The service role can run them; the public roles cannot
do $$ begin
  assert has_function_privilege('service_role', 'public.auto_wa_driver_accept_svc(text, uuid)', 'execute'), 'service role runs it';
  assert not has_function_privilege('anon', 'public.auto_wa_driver_accept_svc(text, uuid)', 'execute'), 'anon cannot';
  assert not has_function_privilege('authenticated', 'public.auto_wa_driver_due_svc()', 'execute'), 'authenticated cannot';
  assert not has_function_privilege('anon', 'public.start_search_svc(uuid, double precision, double precision)', 'execute'), 'anon cannot search';
end $$;
select 'whatsapp drivers: all checks passed' as result;
