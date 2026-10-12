-- Forja Feed, part 2: walks and runs get their own posts, and a full-day
-- post can include the day's cardio minutes. Run once in Supabase's SQL
-- editor, BEFORE the app update ships. Safe while the current app is
-- live: existing posts all become kind 'day' and keep working as before.

-- 1. A post is now one of three kinds. Day posts keep their exercise
--    numbers; walk/run posts carry distance and moving time instead.
alter table public.feed_events
  add column kind text not null default 'day' check (kind in ('day', 'walk', 'run')),
  add column cardio_minutes integer check (cardio_minutes between 1 and 1440),
  add column distance_m integer check (distance_m between 0 and 300000),
  add column duration_s integer check (duration_s between 60 and 21600);

alter table public.feed_events
  alter column streak drop not null,
  alter column pushups drop not null,
  alter column plank_seconds drop not null,
  alter column squats drop not null;

-- Every post must be complete for its kind.
alter table public.feed_events add constraint feed_events_complete_for_kind check (
  (kind = 'day' and streak is not null and pushups is not null and plank_seconds is not null and squats is not null)
  or (kind in ('walk', 'run') and distance_m is not null and duration_s is not null)
);

-- 2. Still one full-day post per player per day, but any number of walks
--    and runs (the server caps those at 10 a day).
alter table public.feed_events drop constraint feed_events_user_id_day_key;
create unique index feed_events_one_day_post on public.feed_events (user_id, day) where kind = 'day';

-- Nothing else changes: the same rules decide who can see posts and give
-- kudos, only the server writes posts, and posts are deleted after 30 days.
