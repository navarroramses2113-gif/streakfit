-- Growth dashboard, real users only (2026-10-19). The founding team
-- (Ramsesn and cofounder Stoicgirl) trains in the app too, which made the
-- numbers look better than they are. Their accounts are now left out of
-- every count. Being on the team list doesn't open the dashboard - that's
-- still only private.admins.
-- Run once in Supabase's SQL editor, after growth-2026-10-18.sql. Safe to run again.

create table if not exists private.team (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table private.team enable row level security;
revoke all on private.team from public, anon, authenticated;
insert into private.team (user_id)
select user_id from public.profiles where lower(username) in ('ramsesn', 'stoicgirl')
on conflict do nothing;

-- Same numbers as before, minus the team. Dates are UTC days.
create or replace function public.growth_stats()
  returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
declare
  result jsonb;
begin
  if not exists (select 1 from private.admins where user_id = (select auth.uid())) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  with team as (
    select user_id from private.team
  ), team_emails as (
    select lower(u.email) as email from auth.users u join team t on t.user_id = u.id where u.email is not null
  ), acc as (
    select p.user_id, p.created_at::date as joined,
           coalesce(nullif(u.data->>'signupSource', ''), 'before tracking') as source
    from public.profiles p
    left join public.user_progress u on u.user_id = p.user_id
    where p.user_id not in (select user_id from team)
  ), act as (
    select user_id, day from public.verified_sets where user_id not in (select user_id from team)
    union
    select user_id, day from public.feed_events where user_id not in (select user_id from team)
  ), wait as (
    select * from public.waitlist where email not in (select email from team_emails)
  ), day1 as (
    select a.user_id, a.source,
           exists (select 1 from act x where x.user_id = a.user_id and x.day between a.joined and a.joined + 1) as trained
    from acc a
  ), wl as (
    select coalesce(source, 'direct') as source, count(*) as n from wait group by 1
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
    'founders', (select count(*) from public.founders where user_id not in (select user_id from team)),
    'reminder_people', (select count(distinct user_id) from public.push_subscriptions where user_id not in (select user_id from team)),
    'friendships', (select count(*) from public.friendships where status = 'accepted'
                      and requester_id not in (select user_id from team) and addressee_id not in (select user_id from team)),
    'best_streak', (select coalesce(max(best_streak), 0) from public.player_stats where user_id not in (select user_id from team)),
    'waitlist', (select count(*) from wait),
    'waitlist_7d', (select count(*) from wait where created_at > now() - interval '7 days'),
    'days', (
      select jsonb_agg(jsonb_build_array(d::date,
        (select count(*) from acc where joined = d::date),
        (select count(*) from wait w where w.created_at::date = d::date),
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

-- Check: 2 on the team, still 1 admin, anon still can't call it.
select (select count(*) from private.team) as team,
       (select count(*) from private.admins) as admins,
       has_function_privilege('anon', 'public.growth_stats()', 'execute') as anon_can_call;
