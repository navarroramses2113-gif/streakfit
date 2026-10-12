-- ============================================================================
-- Forja security fixes (2026-10-05). Safe to run while the OLD app is still
-- live: the old app only ever creates requests as 'pending' and only ever
-- changes a request's status, which is all these rules still allow.
-- ============================================================================

-- 1. CRITICAL: friend requests could be created already 'accepted', which made
--    any signed-in user a "friend" of anyone without consent - and friends can
--    read each other's stats and (until the push-time fix) full progress,
--    including saved GPS routes. Requests may now only be created as pending,
--    and not to yourself.
drop policy "Users can send friend requests" on public.friendships;
create policy "Users can send friend requests"
  on public.friendships for insert to authenticated
  with check (
    auth.uid() = requester_id
    and requester_id <> addressee_id
    and status = 'pending'
    and not exists (
      select 1 from public.blocked_users
      where (blocker_id = auth.uid() and blocked_id = friendships.addressee_id)
         or (blocker_id = friendships.addressee_id and blocked_id = auth.uid())
    )
  );

-- 2. HIGH: whoever received a request could rewrite ANY column of it - e.g.
--    change who it was from to someone else and accept it, forging the same
--    friendship from the other side. Now the only column anyone can update is
--    `status`, and only to 'accepted'.
revoke update on public.friendships from anon, authenticated;
grant update (status) on public.friendships to authenticated;
drop policy "Addressee can respond to friend requests" on public.friendships;
create policy "Addressee can accept friend requests"
  on public.friendships for update to authenticated
  using (auth.uid() = addressee_id)
  with check (auth.uid() = addressee_id and status = 'accepted');

-- 3. Bookkeeping the server needs so its notification functions can't be
--    used to spam people (users can't write either column: see the column
--    grant above, and push_subscriptions has no update policy).
alter table public.friendships add column if not exists notified_at timestamptz;
alter table public.push_subscriptions add column if not exists last_reminded_on date;

-- 4. Usernames: enforce the same rules the app shows (3-20 letters, numbers,
--    underscores) on the server, and make them unique regardless of case so
--    nobody can register "StoicMan" to impersonate "stoicman".
alter table public.profiles add constraint username_format check (username ~ '^[A-Za-z0-9_]{3,20}$');
create unique index if not exists profiles_username_lower_key on public.profiles (lower(username));

-- 5. Phone numbers are no longer collected, but the old live app still sends
--    them and every signed-in user can read every profile column. Until the
--    column is dropped at push time, silently discard any phone number.
create or replace function public.discard_profile_phone() returns trigger
  language plpgsql set search_path = '' as $$
begin
  new.phone := null;
  return new;
end;
$$;
create trigger discard_profile_phone before insert or update on public.profiles
  for each row execute function public.discard_profile_phone();

-- 6. The live app puts each friend's streak straight into HTML. Since a
--    person can write anything into their own progress, a text "streak"
--    could inject script into their friends' screens. Streaks must be numbers.
--    Also cap the size of a progress row so nobody can store megabytes in it.
alter table public.user_progress add constraint progress_streaks_are_numbers check (
  (not (data ? 'streak') or jsonb_typeof(data->'streak') = 'number')
  and (not (data ? 'bestStreak') or jsonb_typeof(data->'bestStreak') = 'number')
);
alter table public.user_progress add constraint progress_size_limit check (pg_column_size(data) <= 2000000);

-- 7. Limits on free-text and abuse: report reasons max 500 characters,
--    push endpoints must be https and of sane length.
alter table public.reports add constraint report_reason_length check (reason is null or length(reason) <= 500);
alter table public.push_subscriptions add constraint push_endpoint_shape check (endpoint ~ '^https://' and length(endpoint) <= 1000);

-- 8. Rate limits, enforced in the database so they can't be skipped:
--    at most 30 friend requests per hour and 20 reports per day per person.
create schema if not exists private;

create or replace function private.limit_friend_requests() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.friendships
      where requester_id = new.requester_id and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'Too many friend requests. Try again later.';
  end if;
  return new;
end;
$$;
create trigger limit_friend_requests before insert on public.friendships
  for each row execute function private.limit_friend_requests();

create or replace function private.limit_reports() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.reports
      where reporter_id = new.reporter_id and created_at > now() - interval '1 day') >= 20 then
    raise exception 'Too many reports today. Try again tomorrow.';
  end if;
  return new;
end;
$$;
create trigger limit_reports before insert on public.reports
  for each row execute function private.limit_reports();

-- 9. Database-linter warnings: pin the trigger function's search path, and
--    stop the API from offering an internal function to the public.
alter function public.notify_friend_request() set search_path = '';
revoke execute on function public.rls_auto_enable() from anon, authenticated, public;
