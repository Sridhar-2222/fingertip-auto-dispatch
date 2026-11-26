-- Fingertip Auto migration 11 (owner, 26 Nov 2026: "proceed with book for later, quick messages, passenger self registration").
-- 1. Book for later (WhatsApp): ride_schedules (one DRAFT per phone while the bot asks when / where to / where from, then
--    SCHEDULED). A 15-second timer rings drivers at the time, retries for up to 15 minutes, and tells the person once if no
--    auto came. The person who booked gets the ride news (driver, PIN) on WhatsApp as usual.
-- 2. Quick messages during a confirmed ride: ride_messages. Passenger (WhatsApp) → driver app; driver app → passenger
--    (WhatsApp, through the same news timer).
-- 3. Self-registration: a WhatsApp number asks the bot for its own app passenger code (REGISTER).
-- Rides only, nothing medicine-related. Tables have no grants; the bot uses the *_svc functions (service_role), the app uses
-- auto_driver_* with its device key.

-- ---------- 1. Book for later ----------
create table if not exists public.ride_schedules (
  id                uuid primary key default gen_random_uuid(),
  phone             text not null check (phone ~ '^[0-9]{8,15}$'),
  for_whom          text check (for_whom is null or char_length(for_whom) <= 60),
  destination_name  text,
  pickup_place      text,
  pickup_lat        double precision,
  pickup_lng        double precision,
  at                timestamptz,
  status            text not null default 'DRAFT' check (status in ('DRAFT','SCHEDULED','RINGING','DONE','CANCELLED','FAILED')),
  ride_id           uuid references public.ride_requests(id),
  tries             integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index if not exists ride_schedules_one_draft on public.ride_schedules (phone) where status = 'DRAFT';
create index if not exists ride_schedules_due on public.ride_schedules (status, at);
alter table public.ride_schedules enable row level security;
revoke all on public.ride_schedules from public, anon, authenticated;

-- The person's draft (started in the last 30 minutes), or null.
create or replace function public.auto_later_get_svc(p_phone text)
returns public.ride_schedules language sql security definer set search_path = public as $$
  select * from ride_schedules where phone = p_phone and status = 'DRAFT' and updated_at > now() - interval '30 minutes' limit 1
$$;

-- Start or fill the draft. p_patch keys (all optional): for_whom, destination, pickup_place, pickup_lat, pickup_lng, at.
create or replace function public.auto_later_set_svc(p_phone text, p_patch jsonb)
returns public.ride_schedules language plpgsql security definer set search_path = public as $$
declare s ride_schedules; t timestamptz;
begin
  if p_phone !~ '^[0-9]{8,15}$' then raise exception 'bad_phone'; end if;
  delete from ride_schedules where phone = p_phone and status = 'DRAFT' and updated_at <= now() - interval '30 minutes';
  insert into ride_schedules (phone) values (p_phone) on conflict (phone) where status = 'DRAFT' do nothing;
  select * into s from ride_schedules where phone = p_phone and status = 'DRAFT' for update;
  if p_patch ? 'at' and nullif(p_patch->>'at', '') is not null then
    t := (p_patch->>'at')::timestamptz;
    if t < now() + interval '5 minutes' or t > now() + interval '7 days' then raise exception 'bad_time'; end if;
    s.at := t;
  end if;
  if p_patch ? 'destination' and exists (select 1 from auto_places where key = p_patch->>'destination' and active) then s.destination_name := p_patch->>'destination'; end if;
  if p_patch ? 'pickup_place' and exists (select 1 from auto_places where key = p_patch->>'pickup_place' and active) then
    s.pickup_place := p_patch->>'pickup_place'; s.pickup_lat := null; s.pickup_lng := null;
  end if;
  if p_patch ? 'pickup_lat' and p_patch ? 'pickup_lng' then
    s.pickup_lat := (p_patch->>'pickup_lat')::double precision; s.pickup_lng := (p_patch->>'pickup_lng')::double precision; s.pickup_place := null;
  end if;
  if p_patch ? 'for_whom' then s.for_whom := nullif(btrim(left(p_patch->>'for_whom', 60)), ''); end if;
  update ride_schedules set at = s.at, destination_name = s.destination_name, pickup_place = s.pickup_place,
         pickup_lat = s.pickup_lat, pickup_lng = s.pickup_lng, for_whom = s.for_whom, updated_at = now()
   where id = s.id returning * into s;
  return s;
end $$;

-- Draft → SCHEDULED (time, destination and pickup must all be set).
create or replace function public.auto_later_confirm_svc(p_phone text)
returns public.ride_schedules language plpgsql security definer set search_path = public as $$
declare s ride_schedules;
begin
  select * into s from ride_schedules where phone = p_phone and status = 'DRAFT' for update;
  if s.id is null then raise exception 'no_draft'; end if;
  if s.at is null or s.destination_name is null or (s.pickup_place is null and s.pickup_lat is null) then raise exception 'incomplete'; end if;
  if s.at < now() + interval '2 minutes' then raise exception 'bad_time'; end if;
  if (select count(*) from ride_schedules where phone = p_phone and status in ('SCHEDULED','RINGING')) >= 3 then raise exception 'too_many'; end if;
  update ride_schedules set status = 'SCHEDULED', updated_at = now() where id = s.id returning * into s;
  return s;
end $$;

-- Cancel the draft and every upcoming booking of this phone. Returns how many were cancelled.
create or replace function public.auto_later_cancel_svc(p_phone text)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update ride_schedules set status = 'CANCELLED', updated_at = now() where phone = p_phone and status in ('DRAFT','SCHEDULED');
  get diagnostics n = row_count;
  return n;
end $$;

-- Upcoming bookings of this phone (for "MY BOOKINGS").
create or replace function public.auto_later_list_svc(p_phone text)
returns setof public.ride_schedules language sql stable security definer set search_path = public as $$
  select * from ride_schedules where phone = p_phone and status in ('SCHEDULED','RINGING') order by at limit 5
$$;

-- Timer: ring at the time; retry quietly for up to 15 minutes; tell once if no auto came.
create or replace function public.auto_later_tick()
returns integer language plpgsql security definer set search_path = public, extensions as $$
declare s ride_schedules; r ride_requests; n integer := 0;
begin
  for s in select * from ride_schedules where status in ('SCHEDULED','RINGING') and at <= now() order by at limit 20 for update skip locked loop
    if s.ride_id is not null then select * into r from ride_requests where id = s.ride_id; else r := null; end if;
    if s.status = 'RINGING' and r.id is not null then
      if r.status in ('CONFIRMED','COMPLETED') or (r.status = 'CANCELLED' and r.cancel_reason = 'passenger') then
        update ride_schedules set status = 'DONE', updated_at = now() where id = s.id; continue;
      end if;
      if r.status in ('SEARCHING','AWAITING_LOCATION') then continue; end if;   -- still ringing
      if r.status = 'NO_AUTO' and (s.tries >= 10 or now() > s.at + interval '15 minutes') then
        update ride_requests set cancel_reason = 'scheduled_no_auto', wa_told = null where id = r.id;   -- one "no auto" message
        update ride_schedules set status = 'FAILED', updated_at = now() where id = s.id; continue;
      end if;
      update ride_requests set wa_told = 'NO_AUTO' where id = r.id;   -- quiet retry: no message for this try
    end if;
    r := auto_wa_book_svc(s.phone, coalesce('scheduled' || coalesce(' for ' || s.for_whom, ''), 'scheduled'), s.destination_name);
    update ride_schedules set status = 'RINGING', ride_id = r.id, tries = tries + 1, updated_at = now() where id = s.id;
    if s.pickup_place is not null then perform auto_wa_pickup_svc(r.id, s.pickup_place);
    else perform start_search_svc(r.id, s.pickup_lat, s.pickup_lng); end if;
    n := n + 1;
  end loop;
  -- A first try that found nobody in range is retried quietly too.
  update ride_requests rr set wa_told = 'NO_AUTO'
    from ride_schedules sc
   where sc.ride_id = rr.id and sc.status = 'RINGING' and rr.status = 'NO_AUTO' and rr.wa_told is null
     and coalesce(rr.cancel_reason, '') <> 'scheduled_no_auto';
  return n;
end $$;

-- ---------- 2. Quick messages during a ride ----------
create table if not exists public.ride_messages (
  id          bigint generated always as identity primary key,
  ride_id     uuid not null references public.ride_requests(id) on delete cascade,
  sender      text not null check (sender in ('passenger','driver')),
  body        text not null check (char_length(body) between 1 and 300),
  created_at  timestamptz not null default now(),
  told        boolean not null default false
);
create index if not exists ride_messages_ride on public.ride_messages (ride_id, id);
alter table public.ride_messages enable row level security;
revoke all on public.ride_messages from public, anon, authenticated;

-- Passenger (WhatsApp) → driver. Only during their confirmed ride; at most 30 messages a ride.
create or replace function public.auto_wa_ride_say_svc(p_phone text, p_body text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r ride_requests; b text := btrim(left(coalesce(p_body, ''), 300));
begin
  select * into r from ride_requests where passenger_phone = p_phone and status = 'CONFIRMED' and confirmed_at > now() - interval '3 hours'
   order by confirmed_at desc limit 1;
  if r.id is null then return jsonb_build_object('ok', false, 'reason', 'no_ride'); end if;
  if b = '' then return jsonb_build_object('ok', false, 'reason', 'empty'); end if;
  if (select count(*) from ride_messages where ride_id = r.id and sender = 'passenger') >= 30 then return jsonb_build_object('ok', false, 'reason', 'too_many'); end if;
  insert into ride_messages (ride_id, sender, body, told) values (r.id, 'passenger', b, true);
  return jsonb_build_object('ok', true);
end $$;

-- Driver app → passenger. Only during the driver's confirmed ride; at most 30 messages a ride.
create or replace function public.auto_driver_say(p_key text, p_body text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare dv auto_devices := auto_device_svc(p_key); r ride_requests; b text := btrim(left(coalesce(p_body, ''), 200));
begin
  if dv.id is null or dv.role <> 'driver' then return jsonb_build_object('ok', false, 'reason', 'not_paired'); end if;
  select * into r from ride_requests where assigned_driver_id = dv.driver_id and status = 'CONFIRMED' limit 1;
  if r.id is null then return jsonb_build_object('ok', false, 'reason', 'no_ride'); end if;
  if b = '' then return jsonb_build_object('ok', false, 'reason', 'empty'); end if;
  if (select count(*) from ride_messages where ride_id = r.id and sender = 'driver') >= 30 then return jsonb_build_object('ok', false, 'reason', 'too_many'); end if;
  insert into ride_messages (ride_id, sender, body, told) values (r.id, 'driver', b, r.source <> 'whatsapp');
  return jsonb_build_object('ok', true);
end $$;

-- Driver app: the passenger's messages for the current ride (newest last).
create or replace function public.auto_driver_messages(p_key text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare dv auto_devices := auto_device_svc(p_key); rid uuid;
begin
  if dv.id is null or dv.role <> 'driver' then return jsonb_build_object('ok', false, 'reason', 'not_paired'); end if;
  select id into rid from ride_requests where assigned_driver_id = dv.driver_id and status = 'CONFIRMED' limit 1;
  return jsonb_build_object('ok', true, 'messages', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'from', m.sender, 'body', m.body, 'at', m.created_at) order by m.id)
    from (select * from ride_messages where ride_id = rid order by id desc limit 20) m), '[]'::jsonb));
end $$;

-- Driver messages still to deliver on WhatsApp; each returned once.
create or replace function public.auto_wa_msgs_due_svc()
returns table (id bigint, phone text, body text, driver_name text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
begin
  return query
  with due as (
    select m.id from ride_messages m join ride_requests r on r.id = m.ride_id
     where m.sender = 'driver' and not m.told and r.source = 'whatsapp' and m.created_at > now() - interval '1 hour'
     order by m.id limit 50 for update of m skip locked),
  upd as (update ride_messages m set told = true from due where m.id = due.id returning m.*)
  select u.id, r.passenger_phone, u.body, coalesce(d.name_te, d.name)
    from upd u join ride_requests r on r.id = u.ride_id left join drivers d on d.id = r.assigned_driver_id;
end $$;

-- The timer also wakes the bot for driver messages.
create or replace function public.auto_wa_kick_svc()
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare url text; secret text;
begin
  if not exists (select 1 from ride_requests r where r.source = 'whatsapp' and r.created_at > now() - interval '3 hours'
                   and auto_wa_event(r) is not null and auto_wa_event(r) is distinct from r.wa_told)
     and not exists (select 1 from ride_messages m join ride_requests r on r.id = m.ride_id
                      where m.sender = 'driver' and not m.told and r.source = 'whatsapp' and m.created_at > now() - interval '1 hour') then
    return false;
  end if;
  select decrypted_secret into url    from vault.decrypted_secrets where name = 'fingertip_bot_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'fingertip_bot_secret';
  if url is null or secret is null then return false; end if;
  perform net.http_post(url := url, headers := jsonb_build_object('Content-Type', 'application/json', 'x-auto-notify', secret),
                        body := '{"kind":"auto_news"}'::jsonb);
  return true;
end $$;

-- ---------- 3. Self-registration (app passenger code by WhatsApp) ----------
-- New number: a passenger row and its join code. Already registered: the code again, or a fresh one if a phone already joined.
create or replace function public.auto_wa_register_svc(p_phone text, p_name text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare pa auto_passengers; nm text := nullif(btrim(regexp_replace(left(coalesce(p_name, ''), 40), '\s+', ' ', 'g')), '');
  fresh text := lpad((floor(random() * 1000000))::int::text, 6, '0');
begin
  if p_phone !~ '^91[6-9][0-9]{9}$' then return jsonb_build_object('ok', false, 'reason', 'bad_phone'); end if;
  select * into pa from auto_passengers where phone = p_phone for update;
  if pa.id is null then
    insert into auto_passengers (name, phone) values (coalesce(nm, 'Passenger'), p_phone) returning * into pa;
    return jsonb_build_object('ok', true, 'new', true, 'code', pa.pair_code, 'name', pa.name);
  end if;
  if not pa.active then return jsonb_build_object('ok', false, 'reason', 'removed'); end if;
  update auto_passengers set pair_code = coalesce(pair_code, fresh), pair_fails = 0, name = coalesce(nm, name) where id = pa.id returning * into pa;
  return jsonb_build_object('ok', true, 'new', false, 'code', pa.pair_code, 'name', pa.name);
end $$;

-- ---------- grants and timer ----------
revoke all on function public.auto_later_get_svc(text) from public, anon, authenticated;
revoke all on function public.auto_later_set_svc(text, jsonb) from public, anon, authenticated;
revoke all on function public.auto_later_confirm_svc(text) from public, anon, authenticated;
revoke all on function public.auto_later_cancel_svc(text) from public, anon, authenticated;
revoke all on function public.auto_later_list_svc(text) from public, anon, authenticated;
revoke all on function public.auto_later_tick() from public, anon, authenticated;
revoke all on function public.auto_wa_ride_say_svc(text, text) from public, anon, authenticated;
revoke all on function public.auto_wa_msgs_due_svc() from public, anon, authenticated;
revoke all on function public.auto_wa_kick_svc() from public, anon, authenticated;
revoke all on function public.auto_wa_register_svc(text, text) from public, anon, authenticated;
grant execute on function public.auto_later_get_svc(text), public.auto_later_set_svc(text, jsonb), public.auto_later_confirm_svc(text),
  public.auto_later_cancel_svc(text), public.auto_later_list_svc(text), public.auto_wa_ride_say_svc(text, text),
  public.auto_wa_msgs_due_svc(), public.auto_wa_register_svc(text, text) to service_role;
revoke all on function public.auto_driver_say(text, text) from public;
revoke all on function public.auto_driver_messages(text) from public;
grant execute on function public.auto_driver_say(text, text), public.auto_driver_messages(text) to anon, authenticated;

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'fingertip-ride-later';
  perform cron.schedule('fingertip-ride-later', '15 seconds', 'select public.auto_later_tick()');
end $$;
