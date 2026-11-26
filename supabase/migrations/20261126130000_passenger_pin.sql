-- Fingertip Auto migration 5: permanent passenger PIN (owner, 26 Nov 2026: "a permanent pin is generated on his
-- screen. The customer uses the pin for all his transactions"). Each app passenger gets one 4-digit PIN, always
-- shown on their screen; every ride they book from the app uses it as the ride code the driver types to start.
-- WhatsApp passengers (no app row) keep a new code per ride. Additive: 1 column, 2 functions re-made.
alter table public.auto_passengers
  add column if not exists pin text not null default lpad((floor(random() * 10000))::int::text, 4, '0')
  check (pin ~ '^[0-9]{4}$');

create or replace function public.auto_passenger_me(p_key text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare dv auto_devices := auto_device_svc(p_key);
begin
  if dv.id is null or dv.role <> 'passenger' then return jsonb_build_object('ok', false, 'reason', 'not_paired'); end if;
  return (select jsonb_build_object('ok', true, 'id', p.id, 'name', p.name, 'pin', p.pin)
            from auto_passengers p where p.id = dv.passenger_id);
end $$;

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
  update ride_requests set passenger_id = pa.id, source = 'app', ride_code = pa.pin where id = r.id;
  select count(*) into n from start_search_svc(r.id, p_lat, p_lng);
  return jsonb_build_object('ok', true, 'ride_id', r.id, 'drivers_alerted', n);
end $$;
