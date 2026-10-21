-- Run ONCE in Supabase's SQL editor (2026-10-21), before the app update.
--
-- "Couldn't turn on reminders" on a phone that already had them: a phone
-- keeps the same push address whoever signs in, and the app saved it with
-- an upsert. When the address was already in push_subscriptions (another
-- account on that phone, or the same account from before), the upsert
-- became an UPDATE, which no policy allows - so it was refused (403).
--
-- Now the app calls save_push_subscription(): it saves this phone's push
-- address for whoever is signed in, taking it over from another account if
-- needed. That's safe because the address and its keys are secrets only
-- that phone's browser has - having them is proof it's your phone. The
-- old account simply stops getting reminders on a phone it isn't on.

create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
  returns void
  language plpgsql security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
begin
  if me is null then
    raise exception 'not signed in';
  end if;
  if p_endpoint is null or p_endpoint !~ '^https://' or length(p_endpoint) > 1000
     or coalesce(length(p_p256dh), 0) not between 1 and 200
     or coalesce(length(p_auth), 0) not between 1 and 100 then
    raise exception 'bad subscription';
  end if;

  insert into public.push_subscriptions (endpoint, user_id, p256dh, auth_key)
  values (p_endpoint, me, p_p256dh, p_auth)
  on conflict (endpoint) do update
    set user_id = excluded.user_id,
        p256dh = excluded.p256dh,
        auth_key = excluded.auth_key,
        -- A new owner starts fresh: today's reminder may not have gone to them.
        last_reminded_on = case when public.push_subscriptions.user_id = excluded.user_id then public.push_subscriptions.last_reminded_on end,
        last_reminded_hour = case when public.push_subscriptions.user_id = excluded.user_id then public.push_subscriptions.last_reminded_hour end,
        last_reminded_at = case when public.push_subscriptions.user_id = excluded.user_id then public.push_subscriptions.last_reminded_at end;
end;
$$;

revoke all on function public.save_push_subscription(text, text, text) from public, anon;
grant execute on function public.save_push_subscription(text, text, text) to authenticated;

-- Check: one row, signed_in_only = true.
select count(*) = 1 as function_exists,
       not has_function_privilege('anon', 'public.save_push_subscription(text, text, text)', 'execute') as signed_in_only
from pg_proc where proname = 'save_push_subscription';
