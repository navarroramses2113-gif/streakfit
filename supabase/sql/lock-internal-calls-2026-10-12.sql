-- Run once in Supabase's SQL editor (2026-10-12), BEFORE deploying the new
-- send-reminders, challenge-tick and notify-friend-request. Until they are
-- deployed they simply ignore the extra header, so nothing breaks.
--
-- Those three functions are started by the database itself: the hourly
-- reminders job, the 15-minute challenge job, and the trigger that fires
-- when someone sends a friend request. Until now anyone holding the public
-- app key could start them too. Every call is duplicate-safe, but there's
-- no reason to let strangers make them do work. From now on the database
-- sends a secret along, and the functions refuse any call without it.
--
-- The secret is made right here, inside the database's Vault: it never
-- appears in this file, the app or the repo. App users can't read the
-- Vault or the job list.

-- 1. The secret (made only once).
select vault.create_secret(
  replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  'internal_call_secret',
  'Proves a call to a Forja Edge Function came from the database (pg_cron or a trigger)'
)
where not exists (select 1 from vault.secrets where name = 'internal_call_secret');

-- 2. How a function checks the secret it was sent. Only the server
--    (service role) may ask, so nobody can use this to guess it.
create or replace function public.is_internal_call(candidate text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from vault.decrypted_secrets
    where name = 'internal_call_secret' and decrypted_secret = candidate
  );
$$;
revoke all on function public.is_internal_call(text) from public, anon, authenticated;
grant execute on function public.is_internal_call(text) to service_role;

-- 3. The two scheduled jobs send it: the same calls as before plus one
--    header, read from the Vault each time they run.
select cron.alter_job(
  jobid,
  command := replace(
    command,
    '''Content-Type'', ''application/json''',
    '''Content-Type'', ''application/json'', ''x-internal-secret'', (select decrypted_secret from vault.decrypted_secrets where name = ''internal_call_secret'')'
  )
)
from cron.job
where jobname in ('send-daily-reminders', 'challenge-tick')
  and command not like '%x-internal-secret%';

-- 4. So does the friend-request trigger. It runs as whoever sent the
--    request, so it becomes "security definer" to read the Vault itself.
--    It can still only ever make this one call.
do $$
declare
  def text := pg_get_functiondef('public.notify_friend_request()'::regprocedure);
begin
  if def not like '%x-internal-secret%' then
    execute replace(
      def,
      '''Content-Type'', ''application/json''',
      '''Content-Type'', ''application/json'', ''x-internal-secret'', (select decrypted_secret from vault.decrypted_secrets where name = ''internal_call_secret'')'
    );
  end if;
end $$;
alter function public.notify_friend_request() security definer;

-- Check: all three send the secret, and app users can't run the check.
select 'job ' || jobname as what, command like '%x-internal-secret%' as sends_secret
from cron.job where jobname in ('send-daily-reminders', 'challenge-tick')
union all
select 'friend-request trigger', pg_get_functiondef('public.notify_friend_request()'::regprocedure) like '%x-internal-secret%'
union all
select 'app users blocked from the check', not has_function_privilege('authenticated', 'public.is_internal_call(text)', 'execute');
