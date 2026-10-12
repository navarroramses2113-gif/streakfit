-- Run ONCE in Supabase's SQL editor, AFTER the new app is live (2026-10-05).
-- It has to wait for the new app because the old one still read the two
-- things this removes.

-- 1. Bring leaderboard streaks up to date with days people logged in the
--    old app since the last copy - only where the old record is newer, so
--    it never overwrites a day the server itself logged.
insert into player_stats (user_id, streak, best_streak, last_logged_date, rest_days_used, week_start_date)
select user_id,
       coalesce((data->>'streak')::int, 0),
       coalesce((data->>'bestStreak')::int, 0),
       nullif(data->>'lastLoggedDate', '')::date,
       coalesce((data->>'restDaysUsed')::int, 0),
       nullif(data->>'weekStartDate', '')::date
from user_progress
on conflict (user_id) do update set
  streak = excluded.streak,
  best_streak = excluded.best_streak,
  last_logged_date = excluded.last_logged_date,
  rest_days_used = excluded.rest_days_used,
  week_start_date = excluded.week_start_date,
  updated_at = now()
where excluded.last_logged_date is not null
  and (player_stats.last_logged_date is null or excluded.last_logged_date > player_stats.last_logged_date);

-- 2. Make saved progress private again. Friends could read each other's
--    user_progress (including saved GPS routes); the new app reads friends'
--    streaks from player_stats instead.
drop policy "Users can view their own or accepted friends' progress" on user_progress;
create policy "Users can view their own progress" on user_progress
  for select using (auth.uid() = user_id);

-- 3. Remove the old phone-number column. The temporary trigger that blanked
--    phone numbers goes first - it writes to that column, so leaving it
--    would make every profile save fail.
drop trigger discard_profile_phone on public.profiles;
drop function public.discard_profile_phone();
alter table public.profiles drop column phone;
