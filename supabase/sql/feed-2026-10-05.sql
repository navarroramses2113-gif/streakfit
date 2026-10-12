-- Forja Feed: friends see each other's logged days and can give kudos.
-- Run once in Supabase's SQL editor. Safe while the old app is still live:
-- it only ADDS tables, and nothing reads them until the new app ships.

-- 1. Feed posts. One per player per logged day, written only by the log-day
--    server function (its service-role key skips these rules). There is
--    deliberately no insert/update/delete policy, so nobody can post, edit
--    or fake an entry from the app - every post is a day the server verified.
create table public.feed_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  streak integer not null check (streak between 0 and 100000),
  pushups integer not null check (pushups >= 0),
  plank_seconds integer not null check (plank_seconds >= 0),
  squats integer not null check (squats >= 0),
  new_best boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, day)
);
alter table public.feed_events enable row level security;
revoke insert, update, delete, truncate on public.feed_events from anon, authenticated;

-- You see your own posts and your accepted friends' posts - nobody else's.
-- (Blocking someone deletes the friendship, so it hides both feeds too.)
create policy "Users can view their own and friends' feed posts" on public.feed_events
  for select to authenticated using (
    user_id = (select auth.uid())
    or exists (
      select 1 from public.friendships f
      where f.status = 'accepted'
        and ((f.requester_id = (select auth.uid()) and f.addressee_id = feed_events.user_id)
          or (f.addressee_id = (select auth.uid()) and f.requester_id = feed_events.user_id))
    )
  );

-- 2. Kudos. One per person per post; tapping again takes it back.
create table public.kudos (
  event_id uuid not null references public.feed_events(id) on delete cascade,
  giver_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (event_id, giver_id)
);
create index kudos_giver_id_idx on public.kudos (giver_id);
alter table public.kudos enable row level security;
-- The app may only fill in WHICH post and WHO; created_at is always the
-- real time (the rate limit below counts on it).
revoke insert, update, truncate on public.kudos from anon, authenticated;
grant insert (event_id, giver_id) on public.kudos to authenticated;

-- Kudos are visible on any post you can see (the rule above decides that),
-- except ones from people you've blocked.
create policy "Users can view kudos on posts they can see" on public.kudos
  for select to authenticated using (
    exists (select 1 from public.feed_events e where e.id = kudos.event_id)
    and not exists (
      select 1 from public.blocked_users b
      where b.blocker_id = (select auth.uid()) and b.blocked_id = kudos.giver_id
    )
  );

-- Only as yourself, only on a post you can see, and never on your own.
create policy "Users can give kudos to friends' posts" on public.kudos
  for insert to authenticated with check (
    giver_id = (select auth.uid())
    and exists (
      select 1 from public.feed_events e
      where e.id = kudos.event_id and e.user_id <> (select auth.uid())
    )
  );

create policy "Users can take back their own kudos" on public.kudos
  for delete to authenticated using (giver_id = (select auth.uid()));

-- 3. Rate limit, same style as friend requests and reports.
create schema if not exists private;
create or replace function private.limit_kudos() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.kudos
      where giver_id = new.giver_id and created_at > now() - interval '1 hour') >= 300 then
    raise exception 'Too many kudos. Try again later.';
  end if;
  return new;
end;
$$;
create trigger limit_kudos before insert on public.kudos
  for each row execute function private.limit_kudos();

-- 4. Posts (and their kudos) are deleted after 30 days. The app only shows
--    the last two weeks, so there's no reason to keep them longer.
select cron.schedule(
  'prune-old-feed-posts',
  '30 4 * * *',
  $$delete from public.feed_events where created_at < now() - interval '30 days'$$
);
