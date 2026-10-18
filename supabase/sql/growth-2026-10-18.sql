-- Growth dashboard (2026-10-18): the numbers behind getforja.app/growth.html.
-- Run once in Supabase's SQL editor. Safe to run again.
--
-- Only counts ever leave the database - no names, emails or anyone's
-- workouts - and only to accounts on the admin list (Ramsesn).

-- Who may see the dashboard. In the private schema: the app can't read it.
create table if not exists private.admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
revoke all on private.admins from public, anon, authenticated;
insert into private.admins (user_id)
select user_id from public.profiles where lower(username) = 'ramsesn'
on conflict do nothing;

-- Everything the page shows, as one JSON object. Dates are UTC days.
-- "Trained" = a verified set or a server-written walk/run/day that day.
create or replace function public.growth_stats()
  returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
declare
  result jsonb;
begin
  if not exists (select 1 from private.admins where user_id = (select auth.uid())) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  with acc as (
    select p.user_id, p.created_at::date as joined,
           coalesce(nullif(u.data->>'signupSource', ''), 'before tracking') as source
    from public.profiles p
    left join public.user_progress u on u.user_id = p.user_id
  ), act as (
    select user_id, day from public.verified_sets
    union
    select user_id, day from public.feed_events
  ), day1 as (
    select a.user_id, a.source,
           exists (select 1 from act x where x.user_id = a.user_id and x.day between a.joined and a.joined + 1) as trained
    from acc a
  ), wl as (
    select coalesce(source, 'direct') as source, count(*) as n from public.waitlist group by 1
  ), src as (
    select source from acc union select source from wl
  )
  select jsonb_build_object(
    'as_of', now(),
    'accounts', (select count(*) from acc),
    'new_7d', (select count(*) from acc where joined > current_date - 7),
    'trained_7d', (select count(distinct user_id) from act where day > current_date - 7),
    'trained_today', (select count(distinct user_id) from act where day = current_date),
    'day1_trained', (select count(*) from day1 where trained),
    'day7_eligible', (select count(*) from acc where joined <= current_date - 8),
    'day7_back', (select count(*) from acc a where a.joined <= current_date - 8
                    and exists (select 1 from act x where x.user_id = a.user_id and x.day between a.joined + 6 and a.joined + 8)),
    'founders', (select count(*) from public.founders),
    'reminder_people', (select count(distinct user_id) from public.push_subscriptions),
    'friendships', (select count(*) from public.friendships where status = 'accepted'),
    'best_streak', (select coalesce(max(best_streak), 0) from public.player_stats),
    'waitlist', (select count(*) from public.waitlist),
    'waitlist_7d', (select count(*) from public.waitlist where created_at > now() - interval '7 days'),
    'days', (
      select jsonb_agg(jsonb_build_array(d::date,
        (select count(*) from acc where joined = d::date),
        (select count(*) from public.waitlist w where w.created_at::date = d::date),
        (select count(distinct user_id) from act where day = d::date)) order by d)
      from generate_series(current_date - 20, current_date, interval '1 day') d
    ),
    'sources', (
      select coalesce(jsonb_agg(jsonb_build_array(s.source,
        coalesce((select n from wl where wl.source = s.source), 0),
        (select count(*) from acc where acc.source = s.source),
        (select count(*) from day1 where day1.source = s.source and day1.trained))
        order by s.source), '[]'::jsonb)
      from src s
    )
  ) into result;
  return result;
end;
$$;
revoke all on function public.growth_stats() from public, anon;
grant execute on function public.growth_stats() to authenticated;

-- Check: one admin, and the function answers only for them.
select (select count(*) from private.admins) as admins,
       has_function_privilege('anon', 'public.growth_stats()', 'execute') as anon_can_call;
