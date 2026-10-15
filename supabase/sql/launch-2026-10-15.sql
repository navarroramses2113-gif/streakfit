-- Forja launch pack (2026-10-15): invite links, weekly leagues and the
-- Monday weekly recap push. Run once in Supabase's SQL editor, BEFORE
-- deploying the `invite` and `weekly-recap` functions. Safe to run again.

-- 1. Invite links -----------------------------------------------------------
-- Every account has a private code; its link (?i=<code>) makes whoever signs
-- up from it your friend at once. The code is NOT the username: profiles are
-- readable by every signed-in user, so a username link would let anyone
-- befriend anyone. Only you can read your code; only the server (the
-- `invite` function) looks codes up.
create table if not exists public.invite_codes (
  user_id uuid primary key references auth.users(id) on delete cascade,
  code text not null unique check (code ~ '^[a-f0-9]{10}$'),
  created_at timestamptz not null default now()
);
alter table public.invite_codes enable row level security;
revoke all on public.invite_codes from anon, authenticated;
grant select on public.invite_codes to authenticated;
drop policy if exists "Users can view their own invite code" on public.invite_codes;
create policy "Users can view their own invite code" on public.invite_codes
  for select to authenticated using ((select auth.uid()) = user_id);

-- 10 hex characters from a random UUID (about a trillion codes).
create or replace function private.give_invite_code() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  insert into public.invite_codes (user_id, code)
  values (new.user_id, substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))
  on conflict do nothing;
  return new;
end;
$$;
drop trigger if exists give_invite_code on public.profiles;
create trigger give_invite_code after insert on public.profiles
  for each row execute function private.give_invite_code();

insert into public.invite_codes (user_id, code)
select p.user_id, substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)
from public.profiles p
on conflict do nothing;

-- 2. Leagues ----------------------------------------------------------------
-- Your phone's time zone (for your league's area) and whether you show up
-- in leagues at all. Both are yours to change (the existing "update own
-- profile" policy covers them).
alter table public.profiles add column if not exists time_zone text
  constraint profiles_time_zone_length check (time_zone is null or length(time_zone) <= 64);
alter table public.profiles add column if not exists show_in_leagues boolean not null default true;

-- Start everyone off with the time zone their reminders already use.
update public.profiles p
set time_zone = u.data->>'reminderTimezone'
from public.user_progress u
where u.user_id = p.user_id and p.time_zone is null
  and length(u.data->>'reminderTimezone') between 1 and 64;

-- A time zone -> the area a league is named after. Coarse on purpose: a
-- time zone never says where someone lives, only roughly which part of the
-- world they're in.
create or replace function public.league_region(tz text) returns text
  language sql immutable set search_path = '' as $$
  select case
    when tz is null or tz = '' then 'World'
    when tz in ('America/Chicago', 'America/Menominee', 'America/Indiana/Knox', 'America/Indiana/Tell_City')
      or tz like 'America/North_Dakota/%' then 'US Central'
    when tz in ('America/New_York', 'America/Detroit') or tz like 'America/Indiana/%' or tz like 'America/Kentucky/%' then 'US East'
    when tz in ('America/Denver', 'America/Boise', 'America/Phoenix') then 'US Mountain'
    when tz in ('America/Los_Angeles', 'America/Anchorage', 'America/Juneau', 'America/Sitka', 'America/Nome', 'Pacific/Honolulu') then 'US West'
    when tz = 'America/Puerto_Rico' then 'Puerto Rico'
    when tz in ('America/Toronto', 'America/Montreal', 'America/Vancouver', 'America/Edmonton', 'America/Winnipeg', 'America/Regina',
                'America/Halifax', 'America/St_Johns', 'America/Moncton', 'America/Whitehorse', 'America/Yellowknife') then 'Canada'
    when tz in ('America/Mexico_City', 'America/Cancun', 'America/Merida', 'America/Monterrey', 'America/Matamoros', 'America/Chihuahua',
                'America/Hermosillo', 'America/Mazatlan', 'America/Tijuana', 'America/Bahia_Banderas', 'America/Ojinaga') then 'Mexico'
    when tz like 'America/%' then 'Latin America'
    when tz like 'Europe/%' or tz like 'Atlantic/%' then 'Europe'
    when tz like 'Asia/%' then 'Asia'
    when tz like 'Africa/%' then 'Africa'
    when tz like 'Australia/%' or tz like 'Pacific/%' then 'Oceania'
    else 'World'
  end
$$;

-- One week's league (Monday to Sunday, everyone's own dates), as `viewer`
-- sees it. Points come only from what the server itself wrote (Feed posts,
-- 30 days kept): a finished day = 100, a verified walk or run = 1 a minute,
-- at most 60 a day. Who's in: everyone with points that week who hasn't
-- turned leagues off, plus the viewer. An area with 10+ of them gets its own
-- league; everyone else shares the Forja League. People who blocked each
-- other never see each other. Only names, colors, areas and points leave
-- this function. Server only (the weekly push: only the service role may
-- run it); the app uses league_standings() below.
create or replace function public.league_standings_for(viewer uuid, week_start date)
returns table (user_id uuid, username text, avatar_color text, region text, league text,
               points integer, days integer, place integer, is_you boolean, is_friend boolean)
language sql stable security definer set search_path = '' as $$
  with day_points as (
    select f.user_id, count(distinct f.day)::int as days
    from public.feed_events f
    where f.kind = 'day' and f.day between week_start and week_start + 6
    group by f.user_id
  ),
  move_points as (
    select d.user_id, sum(least(60, d.minutes))::int as minutes
    from (
      select f.user_id, f.day, sum(coalesce(f.duration_s, 0)) / 60 as minutes
      from public.feed_events f
      where f.kind in ('walk', 'run') and f.day between week_start and week_start + 6
      group by f.user_id, f.day
    ) d
    group by d.user_id
  ),
  members as (
    select p.user_id, p.username, p.avatar_color, public.league_region(p.time_zone) as region,
           coalesce(dp.days, 0) as days,
           coalesce(dp.days, 0) * 100 + coalesce(mp.minutes, 0) as points
    from public.profiles p
    left join day_points dp on dp.user_id = p.user_id
    left join move_points mp on mp.user_id = p.user_id
    where p.show_in_leagues
      and (dp.user_id is not null or mp.user_id is not null or p.user_id = viewer)
      and not exists (
        select 1 from public.blocked_users b
        where (b.blocker_id = viewer and b.blocked_id = p.user_id) or (b.blocker_id = p.user_id and b.blocked_id = viewer)
      )
  ),
  placed as (
    select m.*, case when count(*) over (partition by m.region) >= 10 then m.region || ' League' else 'Forja League' end as league
    from members m
  ),
  mine as (select pl.league from placed pl where pl.user_id = viewer)
  select pl.user_id, pl.username, pl.avatar_color, pl.region, pl.league, pl.points, pl.days,
         (rank() over (order by pl.points desc))::int as place,
         pl.user_id = viewer as is_you,
         exists (
           select 1 from public.friendships fr
           where fr.status = 'accepted'
             and ((fr.requester_id = viewer and fr.addressee_id = pl.user_id) or (fr.addressee_id = viewer and fr.requester_id = pl.user_id))
         ) as is_friend
  from placed pl
  where pl.league = coalesce((select league from mine), 'Forja League')
  order by pl.points desc, pl.days desc, pl.username
$$;
revoke all on function public.league_standings_for(uuid, date) from public, anon, authenticated;

-- The app's view: your league for the week starting `week_start` (your
-- own Monday).
create or replace function public.league_standings(week_start date)
returns table (user_id uuid, username text, avatar_color text, region text, league text,
               points integer, days integer, place integer, is_you boolean, is_friend boolean)
language sql stable security definer set search_path = '' as $$
  select * from public.league_standings_for((select auth.uid()), week_start)
$$;
revoke all on function public.league_standings(date) from public, anon;
grant execute on function public.league_standings(date) to authenticated;
grant execute on function public.league_standings_for(uuid, date) to service_role;

create index if not exists feed_events_day_kind on public.feed_events (day, kind);

-- 3. The Monday weekly recap push ------------------------------------------
-- One push per person per week (the primary key), at 9 AM their time on
-- Monday. Only the server writes it; rows go after 60 days.
create table if not exists public.weekly_recap_sent (
  user_id uuid not null references auth.users(id) on delete cascade,
  week date not null,
  created_at timestamptz not null default now(),
  primary key (user_id, week)
);
alter table public.weekly_recap_sent enable row level security;
revoke all on public.weekly_recap_sent from anon, authenticated;

-- Hourly; the function itself picks out whoever it's Monday 9 AM for. Same
-- call the hourly reminders make (address + secret), pointed at
-- weekly-recap, so no key is written here.
select cron.unschedule('weekly-recap') where exists (select 1 from cron.job where jobname = 'weekly-recap');
select cron.schedule(
  'weekly-recap',
  '7 * * * *',
  (select replace(command, 'send-reminders', 'weekly-recap') from cron.job where command like '%send-reminders%' limit 1)
);
select cron.unschedule('weekly-recap-cleanup') where exists (select 1 from cron.job where jobname = 'weekly-recap-cleanup');
select cron.schedule(
  'weekly-recap-cleanup',
  '41 4 * * 2',
  $$delete from public.weekly_recap_sent where created_at < now() - interval '60 days'$$
);

-- Check: should list invite_codes = profiles count, both new columns, the
-- league function and both jobs.
select (select count(*) from public.invite_codes) as invite_codes,
       (select count(*) from public.profiles) as profiles,
       (select count(*) from information_schema.columns where table_name = 'profiles' and column_name in ('time_zone', 'show_in_leagues')) as new_columns,
       (select count(*) from cron.job where jobname in ('weekly-recap', 'weekly-recap-cleanup')) as jobs;
