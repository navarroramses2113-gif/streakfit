-- Reminders: one per day AND chosen hour, instead of one per day. Run once
-- in Supabase's SQL editor, BEFORE deploying the new send-reminders (it
-- writes these columns; until they exist its "reminded" mark would fail).
--
-- Before: once a device got its reminder for the day, moving the reminder
-- to a later hour did nothing until tomorrow - it looked broken. Now the
-- server remembers the hour too, so a new hour still fires that day, while
-- a retried or repeated call within the same hour still can't send twice.
-- last_reminded_at is when it actually went out, for troubleshooting.
--
-- Like last_reminded_on, only the server writes these: push_subscriptions
-- has no update policy, so players can't touch them.
alter table public.push_subscriptions add column if not exists last_reminded_hour smallint check (last_reminded_hour between 0 and 23);
alter table public.push_subscriptions add column if not exists last_reminded_at timestamptz;
