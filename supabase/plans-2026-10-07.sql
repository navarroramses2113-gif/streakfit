-- Forja progressive overload: each player's plan (pace + daily targets).
-- Run once in Supabase's SQL editor. Safe while the current app is live:
-- it only ADDS a table, and nothing reads it until the new app ships.

-- One row per player, written only by the server (the log-day and plan
-- Edge Functions, through the rules in _shared/game-rules.js). There is
-- deliberately no insert/update/delete policy: nobody can lower their own
-- targets from the app. The only choice a player makes - their pace - goes
-- through the plan function, which checks it.
create table public.player_plans (
  user_id uuid primary key references auth.users(id) on delete cascade,
  pace text not null default 'regular' check (pace in ('easy', 'regular', 'serious', 'intense')),
  -- today's targets (before any ease-back for missed days, which is worked
  -- out when they're shown or checked) and where the plan started
  pushups integer not null check (pushups between 1 and 1000),
  squats integer not null check (squats between 1 and 1000),
  planks integer not null check (planks between 1 and 3600),
  start_pushups integer not null check (start_pushups between 1 and 1000),
  start_squats integer not null check (start_squats between 1 and 1000),
  start_planks integer not null check (start_planks between 1 and 3600),
  -- progress toward the next step (0 up to, not including, 1)
  credit double precision not null default 0 check (credit >= 0 and credit < 1),
  -- exercises that skip their next step (needed 3+ sets)
  skip text[] not null default '{}' check (skip <@ array['pushups', 'squats', 'planks']),
  last_day date,
  updated_at timestamptz not null default now()
);
alter table public.player_plans enable row level security;
revoke insert, update, delete, truncate on public.player_plans from anon, authenticated;

create policy "Users can view their own plan" on public.player_plans
  for select to authenticated using (user_id = (select auth.uid()));
