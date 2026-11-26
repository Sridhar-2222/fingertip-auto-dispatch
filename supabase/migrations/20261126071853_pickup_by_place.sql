-- Fingertip Auto migration 8: pickup by place name, no location needed (owner, 26 Nov 2026:
-- "Build pickup by place name, no location needed"). The WhatsApp passenger replies a place number for
-- where they are; the search starts from that place's map point. Sharing a live location still works.
-- auto_places: the pickup points (approximate, from public map listings, 26 Nov 2026) — the owner can
-- correct lat/lng in the Supabase Table Editor at any time. Server-only. Additive: 1 table, 1 column, 1 function.
create table if not exists public.auto_places (
  key     text primary key check (key ~ '^[A-Z_]{2,30}$'),
  te      text not null,
  en      text not null,
  lat     double precision not null check (lat between -90 and 90),
  lng     double precision not null check (lng between -180 and 180),
  active  boolean not null default true,
  note    text
);
alter table public.auto_places enable row level security;
revoke all on public.auto_places from public, anon, authenticated;

insert into public.auto_places (key, te, en, lat, lng, note) values
  ('KOTHIRAMPUR',    'కోతిరాంపూర్',          'Kothirampur',          18.4211, 79.1464, 'approx: locality centre (aurumproptech PIN page)'),
  ('ALGUNUR',        'అలుగునూరు',            'Algunur',              18.3802, 79.1202, 'approx: village centre (indiamapia)'),
  ('BUS_STAND',      'కరీంనగర్ బస్ స్టాండ్', 'Karimnagar Bus Stand', 18.4328, 79.1296, 'approx: Wikivoyage Karimnagar'),
  ('CIVIL_HOSPITAL', 'సివిల్ హాస్పిటల్',      'Civil Hospital',       18.4423, 79.1307, 'approx: District/Civil Hospital listings'),
  ('KAMAN',          'కమాన్',                'Kaman',                18.4280, 79.1352, 'approx: Kaman chowrasta listing'),
  ('HUSNABAD',       'హుస్నాబాద్',            'Husnabad',             18.1272, 79.2076, 'approx: town centre (Wikipedia)')
on conflict (key) do nothing;

alter table public.ride_requests add column if not exists pickup_place text;

-- Start the search from a named place (WhatsApp ride waiting for its pickup). Returns how many drivers were alerted
-- (0 = no auto nearby; the ride is then closed as NO_AUTO by start_search_svc), or null for an unknown place.
create or replace function public.auto_wa_pickup_svc(p_ride_id uuid, p_place text)
returns integer
language plpgsql security definer set search_path = public, extensions as $$
declare pl auto_places; n integer;
begin
  select * into pl from auto_places where key = p_place and active;
  if pl.key is null then return null; end if;
  update ride_requests set pickup_place = pl.key where id = p_ride_id and status = 'AWAITING_LOCATION';
  select count(*) into n from start_search_svc(p_ride_id, pl.lat, pl.lng);
  return n;
end $$;

revoke all on function public.auto_wa_pickup_svc(uuid, text) from public, anon, authenticated;
grant execute on function public.auto_wa_pickup_svc(uuid, text) to service_role;
