-- Why camera sets come out lower than expected. Run once in Supabase's SQL
-- editor, BEFORE deploying the new submit-set (until the table exists, the
-- function just logs that it couldn't write a note - sets still save).
--
-- submit-set writes one row per recounted set: how many reps counted and
-- how many dips each check turned down ("shallow", "bad_posture", ...),
-- how much of the set the body was out of sight, and when the start
-- position was first recognized (null = never). Counts only - no body
-- positions are kept, the same promise the privacy policy makes.
--
-- Nobody can read or write it from the app: it's for troubleshooting from
-- the Supabase side. Rows go 30 days after they're written, and with the
-- account (on delete cascade).
create table public.set_checks (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  exercise text not null check (exercise in ('pushup', 'squat', 'plank')),
  counted integer not null check (counted >= 0),
  plausible boolean not null,
  duration_ms integer not null check (duration_ms >= 0),
  rejected jsonb not null default '{}',
  lost_share real not null check (lost_share between 0 and 1),
  ready_ms integer check (ready_ms >= 0),
  created_at timestamptz not null default now()
);
create index set_checks_user_day on public.set_checks (user_id, day);
create index set_checks_created_at on public.set_checks (created_at);

alter table public.set_checks enable row level security;
revoke all on public.set_checks from anon, authenticated;

select cron.schedule(
  'set-checks-cleanup',
  '17 4 * * *',
  $$delete from public.set_checks where created_at < now() - interval '30 days'$$
);
