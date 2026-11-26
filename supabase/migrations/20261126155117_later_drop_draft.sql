-- Fingertip Auto migration 12: stopping a booking that is still being filled in must not cancel bookings already made.
create or replace function public.auto_later_drop_svc(p_phone text)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update ride_schedules set status = 'CANCELLED', updated_at = now() where phone = p_phone and status = 'DRAFT';
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.auto_later_drop_svc(text) from public, anon, authenticated;
grant execute on function public.auto_later_drop_svc(text) to service_role;
