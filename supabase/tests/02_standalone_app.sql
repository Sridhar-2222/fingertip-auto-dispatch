-- LOCAL TESTING ONLY. Run after both migrations on a throwaway database.
set search_path = public, extensions;
truncate public.driver_pings, public.ride_requests, public.drivers, public.processed_messages cascade;

insert into drivers (id, name, phone, auto_number, pair_code, status, last_location, last_ping_at) values
 ('00000000-0000-0000-0000-0000000000a1','Ravi', '919800000001','TS02UB0001','111111','OFFLINE', ST_MakePoint(79.1288,18.4400)::geography, now()),
 ('00000000-0000-0000-0000-0000000000a2','Srinu','919800000002','TS02UB0002','222222','OFFLINE', ST_MakePoint(79.1288,18.4450)::geography, now());

-- helper: act as a signed-in app user
create or replace function pg_temp.as_user(uid text) returns void language sql as
$$ select set_config('request.jwt.claim.sub', uid, false) $$;

-- 1. Pairing
select pg_temp.as_user('20000000-0000-0000-0000-0000000000a1');
set role authenticated;
do $$
declare j jsonb;
begin
  j := claim_driver_self('9800000001', '000000');
  assert j->>'reason' = 'wrong_code', 'wrong code refused';
  j := claim_driver_self('9999999999', '111111');
  assert j->>'reason' = 'unknown_phone', 'unknown phone refused';
  j := claim_driver_self('98000 00001', '111111');
  assert (j->>'ok')::boolean and j->>'name' = 'Ravi', 'paired: ' || j::text;
  assert (driver_me_self())->>'name' = 'Ravi', 'me works';
  assert (driver_me_self()) ? 'pair_code' = false, 'no code in profile';
  raise notice 'PASS 1 pairing';
end $$;
reset role;
do $$ begin
  assert (select pair_code from drivers where name = 'Ravi') is null, 'code used up';
  assert (select pair_fails from drivers where name = 'Ravi') = 0, 'fails reset';
end $$;

-- 2. Lockout after 5 wrong codes
select pg_temp.as_user('20000000-0000-0000-0000-0000000000ff');
set role authenticated;
do $$
declare i int; j jsonb;
begin
  for i in 1..5 loop perform claim_driver_self('9800000002', '000000'); end loop;
  j := claim_driver_self('9800000002', '222222');
  assert j->>'reason' = 'locked', 'locked after 5 tries: ' || j::text;
  raise notice 'PASS 2 lockout';
end $$;
reset role;
update drivers set pair_fails = 0 where name = 'Srinu';   -- owner resets in Table Editor

select pg_temp.as_user('20000000-0000-0000-0000-0000000000a2');
set role authenticated;
do $$ begin assert (claim_driver_self('9800000002', '222222')->>'ok')::boolean, 'Srinu paired'; end $$;

-- 3. Pairing code not readable through the table
do $$
declare ok boolean := false;
begin
  begin perform pair_code from public.drivers; exception when insufficient_privilege then ok := true; end;
  assert ok, 'pair_code hidden';
  raise notice 'PASS 3 code hidden';
end $$;
reset role;

-- Both drivers go on duty with fresh GPS
select pg_temp.as_user('20000000-0000-0000-0000-0000000000a1'); set role authenticated;
select driver_heartbeat_self(18.4400, 79.1288); select set_duty_self(true);
reset role;
select pg_temp.as_user('20000000-0000-0000-0000-0000000000a2'); set role authenticated;
select driver_heartbeat_self(18.4450, 79.1288); select set_duty_self(true);
reset role;

-- 4. A WhatsApp ride (created by the Edge Function with the service role)
do $$
declare r ride_requests; n int;
begin
  r := create_ride_svc('919811111111', 'కమాన్ కి', 'KAMAN');
  select count(*) into n from start_search_svc(r.id, 18.4386, 79.1288);
  assert n = 2, 'two paired drivers alerted, got ' || n;
  perform set_config('test.tok', r.access_token, false);
  raise notice 'PASS 4 ride from WhatsApp alerts app drivers';
end $$;

-- 5. Drivers race: Srinu first, Ravi second; driver never sees the passenger's link token
select pg_temp.as_user('20000000-0000-0000-0000-0000000000a2'); set role authenticated;
do $$
declare rid uuid; j jsonb;
begin
  select ride_id into rid from driver_pings limit 1;   -- RLS: own pings only
  assert (driver_open_ping_self())->>'ride_id' = rid::text, 'open ping for the app';
  assert (select count(*) from driver_pings) = 1, 'driver sees only own ping';
  j := accept_ride_self(rid);
  assert (j->>'ok')::boolean and j->>'passenger_phone' = '919811111111', 'Srinu wins';
  assert not (j ? 'access_token') and not (j ? 'other_driver_ids'), 'no token leaked';
  assert (driver_current_ride_self())->>'passenger_phone' = '919811111111', 'current ride';
  perform set_config('test.rid', rid::text, false);
end $$;
reset role;
select pg_temp.as_user('20000000-0000-0000-0000-0000000000a1'); set role authenticated;
do $$
begin
  assert accept_ride_self(current_setting('test.rid')::uuid)->>'reason' = 'taken', 'Ravi: taken';
  assert (select ping_status from driver_pings) = 'TAKEN', 'Ravi sees TAKEN (alert closes)';
  assert driver_open_ping_self() is null, 'no open alert after taken';
  raise notice 'PASS 5 accept race via app';
end $$;
reset role;

-- 6. Passenger replies "cancel" on WhatsApp → driver freed
do $$
declare j jsonb;
begin
  j := cancel_by_phone_svc('919811111111');
  assert (j->>'ok')::boolean and j->>'driver_phone' = '919800000002', 'cancel tells which driver: ' || j::text;
  assert (select status from drivers where name='Srinu') = 'AVAILABLE', 'Srinu free';
  assert not (cancel_by_phone_svc('919811111111')->>'ok')::boolean, 'nothing left to cancel';
  raise notice 'PASS 6 cancel by WhatsApp reply';
end $$;

-- 7. Skip + complete via app
do $$ declare r ride_requests; begin
  r := create_ride_svc('919822222222', null, 'BUS_STAND');
  perform start_search_svc(r.id, 18.4386, 79.1288);
  perform set_config('test.rid2', r.id::text, false);
end $$;
select pg_temp.as_user('20000000-0000-0000-0000-0000000000a1'); set role authenticated;
do $$ begin
  assert (decline_ride_self(current_setting('test.rid2')::uuid)->>'ok')::boolean, 'skip ok';
end $$;
reset role;
select pg_temp.as_user('20000000-0000-0000-0000-0000000000a2'); set role authenticated;
do $$ begin
  assert (accept_ride_self(current_setting('test.rid2')::uuid)->>'ok')::boolean, 'Srinu accepts after Ravi skipped';
  assert (complete_ride_self(current_setting('test.rid2')::uuid)->>'ok')::boolean, 'trip done';
  raise notice 'PASS 7 skip / complete';
end $$;
reset role;

-- 8. Timer job: closes expired rides and calls the Edge Function only then
do $$ declare r ride_requests; n int; begin
  assert expire_and_notify_svc() = 0 and (select count(*) from net.calls) = 0, 'nothing due → no call';
  r := create_ride_svc('919833333333', null, 'KAMAN');
  perform start_search_svc(r.id, 18.4386, 79.1288);
  update ride_requests set expires_at = now() - interval '1 s' where id = r.id;
  -- no Vault secrets yet: still closes, sends nothing
  assert expire_and_notify_svc() = 1, 'closed';
  assert (select status from ride_requests where id = r.id) = 'NO_AUTO', 'NO_AUTO';
  assert (select count(*) from net.calls) = 0, 'no secrets → no call';
  insert into vault.secrets_store values ('fingertip_function_url', 'https://x.supabase.co/functions/v1/dispatch'),
                                         ('fingertip_cron_secret', 's3cret');
  r := create_ride_svc('919844444444', null, 'KAMAN');
  perform start_search_svc(r.id, 18.4386, 79.1288);
  update ride_requests set expires_at = now() - interval '1 s' where id = r.id;
  assert expire_and_notify_svc() = 1, 'closed 2';
  select count(*) into n from net.calls
   where url = 'https://x.supabase.co/functions/v1/dispatch/notify'
     and headers->>'x-cron-secret' = 's3cret' and body->>'passenger_phone' = '919844444444'
     and jsonb_array_length(body->'timed_out_driver_ids') = 2;
  assert n = 1, 'one notify call with secret';
  raise notice 'PASS 8 timer job';
end $$;

-- 9. anon cannot touch driver functions or tables
select pg_temp.as_user(''); set role anon;
do $$ declare ok boolean := false; begin
  begin perform accept_ride_self(gen_random_uuid()); exception when insufficient_privilege then ok := true; end;
  assert ok, 'anon cannot accept';
  ok := false;
  begin perform cancel_by_phone_svc('919800000000'); exception when insufficient_privilege then ok := true; end;
  assert ok, 'anon cannot cancel others';
  ok := false;
  begin perform 1 from drivers; exception when insufficient_privilege then ok := true; end;
  assert ok, 'anon cannot read drivers';
  raise notice 'PASS 9 anon locked out';
end $$;
reset role;

select 'ALL STANDALONE TESTS PASSED' as result;
