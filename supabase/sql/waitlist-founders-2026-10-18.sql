-- Waitlist + Founding Members (2026-10-18). Run once in Supabase's SQL
-- editor, BEFORE deploying the `waitlist` function. Safe to run again.

-- 1. Waitlist -----------------------------------------------------------------
-- Emails from the front page (getforja.app). Only the server (the `waitlist`
-- function, service role) reads or writes them; nobody else can, not even a
-- signed-in user. ref_code is the person's own invite link (?r=<code>): each
-- friend who joins through it moves them up 10 places.
create table if not exists public.waitlist (
  id bigint generated always as identity primary key,
  email text not null unique
    check (length(email) between 6 and 254 and email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]{2,}$'),
  ref_code text not null unique check (ref_code ~ '^[a-z0-9]{8}$'),
  referred_by text references public.waitlist(ref_code) on delete set null,
  -- Where they came from (?src=tiktok), like sign-ups.
  source text check (source is null or source ~ '^[a-z0-9_-]{1,32}$'),
  -- A scrambled (HMAC) form of the IP address, only to stop one machine
  -- from flooding the list. Wiped after a day (job below).
  ip_hash text check (ip_hash is null or ip_hash ~ '^[a-f0-9]{32}$'),
  created_at timestamptz not null default now()
);
alter table public.waitlist enable row level security;
revoke all on public.waitlist from anon, authenticated;
create index if not exists waitlist_referred_by on public.waitlist (referred_by);
create index if not exists waitlist_created on public.waitlist (created_at);
create index if not exists waitlist_ip_recent on public.waitlist (ip_hash, created_at) where ip_hash is not null;

-- Someone's place in line: join order, minus 10 for each friend they
-- brought. Server only.
create or replace function public.waitlist_place(code text)
  returns table (place bigint, referrals bigint, total bigint)
  language sql stable security definer set search_path = '' as $$
  with counts as (
    select w.id, w.ref_code,
           (select count(*) from public.waitlist r where r.referred_by = w.ref_code) as refs
    from public.waitlist w
  ), scored as (
    select id, ref_code, refs, id - 10 * refs as score from counts
  )
  select (select count(*) from scored o where o.score < s.score or (o.score = s.score and o.id < s.id)) + 1,
         s.refs,
         (select count(*) from scored)
  from scored s
  where s.ref_code = code
$$;
revoke all on function public.waitlist_place(text) from public, anon, authenticated;
grant execute on function public.waitlist_place(text) to service_role;

-- The scrambled IPs are only needed for an hour; keep them a day at most.
select cron.unschedule('waitlist-forget-ip') where exists (select 1 from cron.job where jobname = 'waitlist-forget-ip');
select cron.schedule('waitlist-forget-ip', '23 * * * *',
  $$update public.waitlist set ip_hash = null where ip_hash is not null and created_at < now() - interval '1 day'$$);

-- 2. Founding Members ---------------------------------------------------------
-- Everyone who joins before the App Store launch (the beta) is a Founding
-- Member: Forja Pro free for 12 months once Pro exists, then $1.99/month for
-- life. Written down now so the promise survives whatever the app becomes.
-- You can read your own row; only the server writes.
create table if not exists public.founders (
  user_id uuid primary key references auth.users(id) on delete cascade,
  since timestamptz not null default now(),
  free_months int not null default 12 check (free_months between 0 and 24),
  monthly_price_cents int not null default 199 check (monthly_price_cents between 0 and 9999)
);
alter table public.founders enable row level security;
revoke all on public.founders from anon, authenticated;
grant select on public.founders to authenticated;
drop policy if exists "Users can view their own founder row" on public.founders;
create policy "Users can view their own founder row" on public.founders
  for select to authenticated using ((select auth.uid()) = user_id);

-- Open until the App Store launch. At launch, replace the body with
-- `select false`: from then on only people from the waitlist still become
-- founders when they sign up.
create or replace function private.founders_open() returns boolean
  language sql immutable set search_path = '' as $$ select true $$;

create or replace function private.make_founder() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if private.founders_open() or exists (
    select 1 from auth.users u join public.waitlist w on w.email = lower(u.email) where u.id = new.user_id
  ) then
    insert into public.founders (user_id) values (new.user_id) on conflict do nothing;
  end if;
  return new;
end;
$$;
revoke all on function private.make_founder() from public, anon, authenticated;
drop trigger if exists make_founder on public.profiles;
create trigger make_founder after insert on public.profiles
  for each row execute function private.make_founder();

-- Everyone already here is a founder, from the day they signed up.
insert into public.founders (user_id, since)
select p.user_id, coalesce(p.created_at, now()) from public.profiles p
on conflict do nothing;

-- Check: should show both tables, every profile a founder, the job.
select (select count(*) from public.waitlist) as waitlist,
       (select count(*) from public.founders) as founders,
       (select count(*) from public.profiles) as profiles,
       (select count(*) from cron.job where jobname = 'waitlist-forget-ip') as jobs;
