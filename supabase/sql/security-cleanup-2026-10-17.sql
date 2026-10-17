-- Security + performance cleanup (2026-10-17), from Supabase's advisors and
-- a review of who can do what. Run once in Supabase's SQL editor. Safe to
-- run again. Apart from one bug fix (section 6: someone you blocked could
-- still send you friend requests), nothing here changes what the app does
-- for a signed-in player: every permission it takes away is one the app
-- never uses, and every access rule keeps exactly the same meaning.
--
-- Requires the app version that no longer reads other players' time zones
-- (commit 80b6764). The live app before that push never read them either.

begin;

-- 1. Signed-out visitors (the `anon` role) ----------------------------------
-- Guests keep their data on their own phone and only ever reach the server
-- through Edge Functions, so anon needs nothing in the database. Until now
-- every table was granted to anon and only the access rules kept it out.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from anon;
-- Tables and sequences made later start the same way.
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;

-- 2. Signed-in players: permissions nothing uses ----------------------------
-- TRUNCATE (empty a whole table), REFERENCES and TRIGGER skip the access
-- rules entirely. The API can't send them today; this makes sure nothing
-- ever can.
revoke truncate, references, trigger on all tables in schema public from authenticated;
-- Streaks and verified sets are written by the server only.
revoke insert, update, delete on public.player_stats from authenticated;
revoke insert, update, delete on public.verified_sets from authenticated;
-- Never deleted or edited from the app (accounts are deleted by the server;
-- unblocking deletes a block, it never edits one; a report is final).
revoke delete on public.profiles from authenticated;
revoke delete on public.user_progress from authenticated;
revoke update on public.blocked_users from authenticated;
revoke select, update, delete on public.reports from authenticated;
-- (friendships and kudos are left alone: their write permissions are
-- per-column, and a table-wide revoke would remove those too.)

-- 3. Time zones stay private ---------------------------------------------------
-- Every signed-in player can read every profile (that's how friend search
-- works), which included each player's time zone - a rough location. Only
-- the server needs it. Profiles stay readable, minus that column.
revoke select on public.profiles from authenticated;
grant select (user_id, username, created_at, avatar_color, show_in_leagues) on public.profiles to authenticated;

-- 4. Functions only the database itself should run --------------------------
-- notify_friend_request and keep_progress_history run as triggers; nobody
-- needs to call them through the API (the advisor flagged the first).
revoke all on function public.notify_friend_request() from public, anon, authenticated;
revoke all on function public.keep_progress_history() from public, anon, authenticated;
-- Used only inside league_standings (which runs as its owner).
revoke all on function public.league_region(text) from public, anon, authenticated;
-- The default for a new profile's color: whoever creates a profile needs it.
revoke all on function public.random_avatar_color() from public, anon;
grant execute on function public.random_avatar_color() to authenticated, service_role;

-- 5. Access rules: same meaning, faster -------------------------------------
-- auth.uid() inside a rule was worked out again for every row; wrapped as
-- (select auth.uid()) it's worked out once per request. Rules that were
-- written "for everyone" are now "for signed-in players", which is who they
-- always applied to (auth.uid() is empty when signed out).

-- blocked_users
drop policy if exists "Users can create their own blocks" on public.blocked_users;
create policy "Users can create their own blocks" on public.blocked_users
  for insert to authenticated with check ((select auth.uid()) = blocker_id);
drop policy if exists "Users can remove their own blocks" on public.blocked_users;
create policy "Users can remove their own blocks" on public.blocked_users
  for delete to authenticated using ((select auth.uid()) = blocker_id);
drop policy if exists "Users can view their own blocks" on public.blocked_users;
create policy "Users can view their own blocks" on public.blocked_users
  for select to authenticated using ((select auth.uid()) = blocker_id);

-- friendships
drop policy if exists "Addressee can accept friend requests" on public.friendships;
create policy "Addressee can accept friend requests" on public.friendships
  for update to authenticated
  using ((select auth.uid()) = addressee_id)
  with check ((select auth.uid()) = addressee_id and status = 'accepted');
drop policy if exists "Users can delete their own friendships" on public.friendships;
create policy "Users can delete their own friendships" on public.friendships
  for delete to authenticated using ((select auth.uid()) in (requester_id, addressee_id));
drop policy if exists "Users can send friend requests" on public.friendships;
create policy "Users can send friend requests" on public.friendships
  for insert to authenticated
  with check (
    (select auth.uid()) = requester_id
    and requester_id <> addressee_id
    and status = 'pending'
    and not exists (
      select 1 from public.blocked_users b
      where (b.blocker_id = (select auth.uid()) and b.blocked_id = addressee_id)
         or (b.blocker_id = addressee_id and b.blocked_id = (select auth.uid()))
    )
  );
drop policy if exists "Users can view their own friendships" on public.friendships;
create policy "Users can view their own friendships" on public.friendships
  for select to authenticated using ((select auth.uid()) in (requester_id, addressee_id));

-- nudges: the two read rules (sent / received) become one.
drop policy if exists "Users can view nudges they sent" on public.nudges;
drop policy if exists "Users can view nudges sent to them" on public.nudges;
drop policy if exists "Users can view nudges they sent or received" on public.nudges;
create policy "Users can view nudges they sent or received" on public.nudges
  for select to authenticated using ((select auth.uid()) in (sender_id, receiver_id));

-- player_stats
drop policy if exists "Users can view their own or accepted friends' stats" on public.player_stats;
create policy "Users can view their own or accepted friends' stats" on public.player_stats
  for select to authenticated
  using (
    (select auth.uid()) = user_id
    or exists (
      select 1 from public.friendships f
      where f.status = 'accepted'
        and ((f.requester_id = (select auth.uid()) and f.addressee_id = player_stats.user_id)
          or (f.addressee_id = (select auth.uid()) and f.requester_id = player_stats.user_id))
    )
  );

-- profiles ("Authenticated users can view all profiles" is unchanged)
drop policy if exists "Users can insert their own profile" on public.profiles;
create policy "Users can insert their own profile" on public.profiles
  for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile" on public.profiles
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- push_subscriptions
drop policy if exists "Users can create their own subscriptions" on public.push_subscriptions;
create policy "Users can create their own subscriptions" on public.push_subscriptions
  for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "Users can delete their own subscriptions" on public.push_subscriptions;
create policy "Users can delete their own subscriptions" on public.push_subscriptions
  for delete to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Users can view their own subscriptions" on public.push_subscriptions;
create policy "Users can view their own subscriptions" on public.push_subscriptions
  for select to authenticated using ((select auth.uid()) = user_id);

-- reports
drop policy if exists "Users can submit reports" on public.reports;
create policy "Users can submit reports" on public.reports
  for insert to authenticated with check ((select auth.uid()) = reporter_id);

-- user_progress
drop policy if exists "Users can insert their own progress" on public.user_progress;
create policy "Users can insert their own progress" on public.user_progress
  for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "Users can update their own progress" on public.user_progress;
create policy "Users can update their own progress" on public.user_progress
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
drop policy if exists "Users can view their own progress" on public.user_progress;
create policy "Users can view their own progress" on public.user_progress
  for select to authenticated using ((select auth.uid()) = user_id);

-- verified_sets
drop policy if exists "Users can view their own verified sets" on public.verified_sets;
create policy "Users can view their own verified sets" on public.verified_sets
  for select to authenticated using ((select auth.uid()) = user_id);

-- 6. Blocks hold both ways for friend requests -------------------------------
-- BUG FIX: the request rule above can only see blocks the sender made
-- (players read only their own blocks), so someone you blocked could still
-- send you a friend request - and a notification. Checked here as the
-- database itself instead. The request is quietly not saved rather than
-- refused, so the sender can't find out they were blocked.
create or replace function private.drop_blocked_friend_requests() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from public.blocked_users b
    where (b.blocker_id = new.addressee_id and b.blocked_id = new.requester_id)
       or (b.blocker_id = new.requester_id and b.blocked_id = new.addressee_id)
  ) then
    return null;
  end if;
  return new;
end;
$$;
revoke all on function private.drop_blocked_friend_requests() from public, anon, authenticated;
drop trigger if exists drop_blocked_friend_requests on public.friendships;
create trigger drop_blocked_friend_requests before insert on public.friendships
  for each row execute function private.drop_blocked_friend_requests();

-- 7. Indexes for lookups by the other person --------------------------------
create index if not exists blocked_users_blocked_id_idx on public.blocked_users (blocked_id);
create index if not exists friendships_addressee_id_idx on public.friendships (addressee_id);
create index if not exists push_subscriptions_user_id_idx on public.push_subscriptions (user_id);
create index if not exists reports_reported_user_id_idx on public.reports (reported_user_id);
create index if not exists reports_reporter_id_idx on public.reports (reporter_id);

commit;

-- Check: every value should read true, and rules_left 0.
select
  not has_table_privilege('anon', 'public.profiles', 'select') as anon_locked_out,
  not has_table_privilege('authenticated', 'public.player_stats', 'truncate') as no_truncate,
  not has_column_privilege('authenticated', 'public.profiles', 'time_zone', 'select') as time_zone_private,
  has_column_privilege('authenticated', 'public.profiles', 'username', 'select') as usernames_readable,
  has_column_privilege('authenticated', 'public.friendships', 'status', 'update') as can_accept_requests,
  has_column_privilege('authenticated', 'public.kudos', 'event_id', 'insert') as can_give_kudos,
  not has_function_privilege('authenticated', 'public.notify_friend_request()', 'execute') as trigger_fn_private,
  exists (select 1 from pg_trigger where tgname = 'drop_blocked_friend_requests') as blocks_hold_both_ways,
  has_function_privilege('authenticated', 'public.random_avatar_color()', 'execute') as new_profiles_get_colors,
  -- Rules where auth.uid() still appears outside a (select auth.uid()).
  (select count(*) from pg_policies, lateral (select coalesce(qual, '') || coalesce(with_check, '') as rule) r
    where schemaname = 'public'
      and length(rule) - length(replace(rule, 'auth.uid()', '')) > 10 * ((length(rule) - length(replace(rule, 'SELECT auth.uid()', ''))) / 17)) as rules_left;
