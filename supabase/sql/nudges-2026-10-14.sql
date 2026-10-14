-- Friend nudges (2026-10-14): tap "Nudge" on a friend who hasn't trained
-- today and they get a push from you. Run once in Supabase's SQL editor,
-- BEFORE deploying the `nudge` function.
--
-- One row per nudge. The primary key is what allows only one nudge per
-- friend per day: `day` is the friend's own date, in their time zone.
-- Only the server writes rows (the nudge function, after checking you're
-- friends, nobody's blocked and they haven't trained yet). You can read
-- the ones you sent, so the app still shows "Nudged" after a reload.
-- Rows go after 30 days, and with either account (on delete cascade).
create table if not exists public.nudges (
  sender_id uuid not null references auth.users(id) on delete cascade,
  receiver_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  created_at timestamptz not null default now(),
  primary key (sender_id, receiver_id, day),
  check (sender_id <> receiver_id)
);
create index if not exists nudges_created_at on public.nudges (created_at);

alter table public.nudges enable row level security;
revoke all on public.nudges from anon, authenticated;
grant select on public.nudges to authenticated;

drop policy if exists "Users can view nudges they sent" on public.nudges;
create policy "Users can view nudges they sent" on public.nudges
  for select to authenticated using (auth.uid() = sender_id);

select cron.schedule(
  'nudges-cleanup',
  '23 4 * * *',
  $$delete from public.nudges where created_at < now() - interval '30 days'$$
);
