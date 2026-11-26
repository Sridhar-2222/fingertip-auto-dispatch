-- Fingertip Auto migration 7: admin live view (owner, 26 Nov 2026: "check both activities live"; "ఉండాలి").
-- One read-only function for the platform owner only (public.is_platform_owner()): drivers (duty, last GPS,
-- joined or not), app passengers (joined or not) and rides of the last 24 hours with their state.
-- Never returns pair codes, device keys or ride PINs. Additive: 1 function.
create or replace function public.auto_admin_live()
returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if not coalesce(public.is_platform_owner(), false) then raise exception 'not_allowed'; end if;
  return jsonb_build_object(
    'at', now(),
    'radius_m', (select search_radius_m from dispatch_settings limit 1),
    'drivers', coalesce((select jsonb_agg(jsonb_build_object(
        'name', d.name, 'phone', d.phone, 'auto_number', d.auto_number, 'status', d.status, 'active', d.active,
        'joined', d.pair_code is null, 'last_ping_at', d.last_ping_at,
        'lat', ST_Y(d.last_location::geometry), 'lng', ST_X(d.last_location::geometry)) order by d.name)
      from drivers d), '[]'::jsonb),
    'passengers', coalesce((select jsonb_agg(jsonb_build_object(
        'name', p.name, 'phone', p.phone, 'joined', p.pair_code is null, 'active', p.active) order by p.name)
      from auto_passengers p), '[]'::jsonb),
    'rides', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id, 'created_at', r.created_at, 'status', r.status, 'source', r.source,
        'passenger_phone', r.passenger_phone, 'destination', r.destination_name, 'cancel_reason', r.cancel_reason,
        'confirmed_at', r.confirmed_at, 'started_at', r.started_at, 'closed_at', r.closed_at,
        'driver', d.name, 'auto_number', d.auto_number,
        'pinged', (select count(*) from driver_pings p where p.ride_id = r.id),
        'pickup_lat', ST_Y(r.pickup_location::geometry), 'pickup_lng', ST_X(r.pickup_location::geometry)) order by r.created_at desc)
      from ride_requests r left join drivers d on d.id = r.assigned_driver_id
      where r.created_at > now() - interval '24 hours'), '[]'::jsonb));
end $$;
revoke all on function public.auto_admin_live() from public, anon;
grant execute on function public.auto_admin_live() to authenticated;
