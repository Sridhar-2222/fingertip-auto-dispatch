-- Fingertip Auto migration 10 (owner, 26 Nov 2026): one "no auto" message, not two. When no driver was in range the bot
-- already answers at once ("no free autos within N km"), so the timer's NO_AUTO news is only for rides where drivers were
-- rung and nobody accepted. Replaces auto_wa_event only.
create or replace function public.auto_wa_event(r public.ride_requests)
returns text language sql immutable as $$
  select case
    when r.status = 'CONFIRMED' and r.started_at is null then 'CONFIRMED'
    when r.status = 'CONFIRMED' then 'STARTED'
    when r.status = 'COMPLETED' then 'COMPLETED'
    when r.status = 'NO_AUTO' and coalesce(r.cancel_reason, '') <> 'no_driver_in_radius' then 'NO_AUTO'
    when r.status = 'CANCELLED' and coalesce(r.cancel_reason, '') not in ('passenger', 'superseded', 'no_location') then 'CANCELLED'
  end
$$;
