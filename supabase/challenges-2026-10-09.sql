-- Forja friend challenges: Rep Race, Distance, Last One Standing, Climb.
-- Run once in Supabase's SQL editor. Safe while the current app is live:
-- it only ADDS tables and a new kind of Feed post, and nothing uses them
-- until the new app ships.
--
-- All three tables are written only by the server (the `challenge` and
-- `challenge-tick` Edge Functions, through the rules in
-- _shared/game-rules.js), and the app reads them only through the
-- `challenge` function too. So RLS is on with NO policies: from the app,
-- nobody can read or change any of it directly.

-- 1. A challenge and what its creator picked. Which columns are filled
--    depends on the type (checked below).
create table public.challenges (
  id uuid primary key default gen_random_uuid(),
  -- kept if the creator deletes their account, so the others can finish
  creator_id uuid references auth.users(id) on delete set null,
  type text not null check (type in ('rep', 'lms', 'climb', 'dist')),
  exercise text check (exercise in ('pushups', 'squats', 'planks')),
  days integer check (days in (3, 7, 14, 30)),
  climb_speed integer check (climb_speed between 1 and 3),
  climb_pushups integer check (climb_pushups between 5 and 300),
  climb_squats integer check (climb_squats between 10 and 500),
  climb_planks integer check (climb_planks between 20 and 1800),
  -- day 1, for every player in their own time zone
  start_day date not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'ended', 'cancelled')),
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  constraint challenges_settings_for_type check (
    (type = 'rep' and exercise is not null and days is not null
      and climb_speed is null and climb_pushups is null and climb_squats is null and climb_planks is null)
    or (type = 'dist' and days is not null and exercise is null
      and climb_speed is null and climb_pushups is null and climb_squats is null and climb_planks is null)
    or (type = 'lms' and exercise is null and days is null
      and climb_speed is null and climb_pushups is null and climb_squats is null and climb_planks is null)
    or (type = 'climb' and exercise is null and days is null
      and climb_speed is not null and climb_pushups is not null and climb_squats is not null and climb_planks is not null)
  )
);
create index challenges_creator_idx on public.challenges (creator_id);
create index challenges_status_idx on public.challenges (status);

-- 2. Who's in it. Everyone invited gets a row; joining locks in the time
--    zone their challenge days follow.
create table public.challenge_players (
  challenge_id uuid not null references public.challenges(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null check (status in ('invited', 'joined', 'declined')),
  time_zone text check (length(time_zone) between 1 and 64),
  -- Last One Standing / Climb: the day number they went out on
  out_day integer check (out_day >= 1),
  -- final place once the challenge ends (ties share a place)
  place integer check (place >= 1),
  -- live place the last time the server looked, for "X passed you"
  rank integer check (rank >= 1),
  passed_notified_on date,
  result_seen boolean not null default false,
  joined_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (challenge_id, user_id),
  constraint challenge_players_joined_have_zone check (status <> 'joined' or time_zone is not null)
);
create index challenge_players_user_idx on public.challenge_players (user_id);

-- 3. Each player's result for each finished challenge day, saved once the
--    day is over in their time zone - so scores don't depend on Feed posts
--    or sets that get cleaned up later.
create table public.challenge_days (
  challenge_id uuid not null,
  user_id uuid not null,
  day date not null,
  value numeric not null check (value >= 0),
  done boolean not null,
  primary key (challenge_id, user_id, day),
  foreign key (challenge_id, user_id) references public.challenge_players (challenge_id, user_id) on delete cascade
);

alter table public.challenges enable row level security;
alter table public.challenge_players enable row level security;
alter table public.challenge_days enable row level security;
revoke all on public.challenges, public.challenge_players, public.challenge_days from anon, authenticated;

-- 4. A new kind of Feed post: "Won the Push-up Race". Written by the
--    server for each winner when a challenge ends; friends see it and give
--    kudos like any other post (the existing Feed rules decide who sees it).
alter table public.feed_events
  add column challenge_type text check (challenge_type in ('rep', 'lms', 'climb', 'dist')),
  add column challenge_exercise text check (challenge_exercise in ('pushups', 'squats', 'planks')),
  add column challenge_value integer check (challenge_value >= 0),
  add column challenge_days integer check (challenge_days between 1 and 365),
  add column challenge_beaten integer check (challenge_beaten between 0 and 10);

alter table public.feed_events drop constraint feed_events_kind_check;
alter table public.feed_events add constraint feed_events_kind_check check (kind in ('day', 'walk', 'run', 'challenge'));

alter table public.feed_events drop constraint feed_events_complete_for_kind;
alter table public.feed_events add constraint feed_events_complete_for_kind check (
  (kind = 'day' and streak is not null and pushups is not null and plank_seconds is not null and squats is not null)
  or (kind in ('walk', 'run') and distance_m is not null and duration_s is not null)
  or (kind = 'challenge' and challenge_type is not null and challenge_value is not null
    and challenge_days is not null and challenge_beaten is not null)
);

-- 5. Every 15 minutes, challenge-tick starts challenges, saves finished
--    days, puts people out and ends challenges. It reuses the call your
--    hourly reminders job already makes (same project address and key),
--    pointed at challenge-tick instead - so no key is written in this file.
--    Run this part AFTER the challenge-tick function is deployed.
select cron.schedule(
  'challenge-tick',
  '*/15 * * * *',
  (select replace(command, 'send-reminders', 'challenge-tick') from cron.job where command like '%send-reminders%' limit 1)
);
