-- Fingertip Auto migration 9: the owner adds people without Supabase (owner, 26 Nov 2026: "We have to keep on adding
-- to Supabase every time" → "without you"). Platform owner only (public.is_platform_owner()):
--   auto_admin_add_driver / auto_admin_add_passenger → a new row and its 6-digit join code (to forward on WhatsApp),
--   auto_admin_code   → the join code again (not joined yet) or a fresh one (new phone),
--   auto_admin_active → remove / bring back a driver or app passenger (removed drivers go OFFLINE).
-- Additive: 1 helper + 4 functions. No table changes.
create or replace function public.auto_norm_phone(p text)
returns text language sql immutable set search_path = public as $$
  select case when length(d) = 10 then '91' || d else d end
    from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d) x
$$;

create or replace function public.auto_admin_add_driver(p_name text, p_phone text, p_auto_number text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare ph text := auto_norm_phone(p_phone); nm text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  an text := upper(regexp_replace(coalesce(p_auto_number, ''), '[^A-Za-z0-9]', '', 'g')); d drivers;
begin
  if not coalesce(public.is_platform_owner(), false) then raise exception 'not_allowed'; end if;
  if ph !~ '^91[6-9][0-9]{9}$' then raise exception 'bad_phone'; end if;
  if char_length(nm) not between 2 and 40 then raise exception 'bad_name'; end if;
  if char_length(an) not between 4 and 12 then raise exception 'bad_auto_number'; end if;
  if exists (select 1 from drivers where phone = ph) then raise exception 'already_added'; end if;
  insert into drivers (name, phone, auto_number) values (nm, ph, an) returning * into d;
  return jsonb_build_object('phone', d.phone, 'name', d.name, 'code', d.pair_code);
end $$;

create or replace function public.auto_admin_add_passenger(p_name text, p_phone text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare ph text := auto_norm_phone(p_phone); nm text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')); pa auto_passengers;
begin
  if not coalesce(public.is_platform_owner(), false) then raise exception 'not_allowed'; end if;
  if ph !~ '^91[6-9][0-9]{9}$' then raise exception 'bad_phone'; end if;
  if char_length(nm) not between 2 and 40 then raise exception 'bad_name'; end if;
  if exists (select 1 from auto_passengers where phone = ph) then raise exception 'already_added'; end if;
  insert into auto_passengers (name, phone) values (nm, ph) returning * into pa;
  return jsonb_build_object('phone', pa.phone, 'name', pa.name, 'code', pa.pair_code);
end $$;

-- p_role 'driver' | 'passenger'. Not joined yet: the same code. Joined: a new code for a new phone (the old phone keeps working).
create or replace function public.auto_admin_code(p_role text, p_phone text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare ph text := auto_norm_phone(p_phone); c text; nm text; fresh text := lpad((floor(random() * 1000000))::int::text, 6, '0');
begin
  if not coalesce(public.is_platform_owner(), false) then raise exception 'not_allowed'; end if;
  if p_role = 'driver' then
    update drivers set pair_code = coalesce(pair_code, fresh), pair_fails = 0 where phone = ph returning pair_code, name into c, nm;
  elsif p_role = 'passenger' then
    update auto_passengers set pair_code = coalesce(pair_code, fresh), pair_fails = 0 where phone = ph returning pair_code, name into c, nm;
  else raise exception 'bad_role'; end if;
  if c is null then raise exception 'not_found'; end if;
  return jsonb_build_object('phone', ph, 'name', nm, 'code', c);
end $$;

create or replace function public.auto_admin_active(p_role text, p_phone text, p_on boolean)
returns boolean language plpgsql security definer set search_path = public as $$
declare ph text := auto_norm_phone(p_phone); n int;
begin
  if not coalesce(public.is_platform_owner(), false) then raise exception 'not_allowed'; end if;
  if p_role = 'driver' then
    update drivers set active = p_on, status = case when p_on then status else 'OFFLINE' end where phone = ph;
  elsif p_role = 'passenger' then
    update auto_passengers set active = p_on where phone = ph;
  else raise exception 'bad_role'; end if;
  get diagnostics n = row_count;
  return n > 0;
end $$;

revoke all on function public.auto_norm_phone(text) from public, anon;
revoke all on function public.auto_admin_add_driver(text, text, text) from public, anon;
revoke all on function public.auto_admin_add_passenger(text, text) from public, anon;
revoke all on function public.auto_admin_code(text, text) from public, anon;
revoke all on function public.auto_admin_active(text, text, boolean) from public, anon;
grant execute on function public.auto_admin_add_driver(text, text, text) to authenticated;
grant execute on function public.auto_admin_add_passenger(text, text) to authenticated;
grant execute on function public.auto_admin_code(text, text) to authenticated;
grant execute on function public.auto_admin_active(text, text, boolean) to authenticated;
